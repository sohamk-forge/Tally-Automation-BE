import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { resolveUserId } from "../utils/resolveUserId.js";

/**
 * Company-level tenant guard.
 *
 * Most routes take the company from the request (company_id / companyId /
 * x-company-id / company name) and query with it directly. Without this,
 * any authenticated user could read or change another company's data just
 * by changing that value.
 *
 * Access source is the same one companies.routes.js, invoices.routes.js and
 * sync.routes.js already use: a used connector_pairing_tokens row for this
 * user (invitees get cloned rows on approval — see invite.service.js).
 */

const ID_KEYS = ["company_id", "companyId", "companyid"];
const NAME_KEYS = ["company", "company_name", "companyName"];
const EMPTY_VALUES = new Set(["", "undefined", "null"]);

// Routers that authorise company access themselves, or that legitimately
// receive a company the user doesn't own yet (signup, connector pairing).
const SKIP_PREFIXES = [
  "/api/account",
  "/api/invites",
  "/api/users",
  "/api/email-verification",
  "/api/companies",
  "/api/sync",
  "/api/connector",
  "/api/db",
];

const normalizeName = (name) => String(name).trim().toLowerCase();

const deny = (res, code, message) =>
  res.status(code).json({ status: "error", success: false, message });

/**
 * Loads (once per request) the companies the caller can access.
 * Returns null when the request isn't tied to a local user.
 */
export async function getCompanyAccess(req) {
  if (req.companyAccess) return req.companyAccess;

  const userId = await resolveUserId(req);
  if (!userId) return null;

  const { rows } = await pool.query(
    `
    SELECT DISTINCT c.id, c.name
    FROM ${DB_SCHEMA}.companies c
    JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt ON cpt.company_id = c.id
    WHERE cpt.user_id = $1
      AND cpt.is_used = TRUE
    ORDER BY c.id DESC
    `,
    [userId]
  );

  const ids = new Set();
  // name -> first (newest) id, for resolving a name to one company;
  // idsByName keeps every id, since one user can own two same-named companies.
  const byName = new Map();
  const idsByName = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    ids.add(id);
    const key = normalizeName(row.name || "");
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, id);
    if (!idsByName.has(key)) idsByName.set(key, new Set());
    idsByName.get(key).add(id);
  }

  req.companyAccess = { userId, ids, byName, idsByName };
  return req.companyAccess;
}

const flatten = (value) => (Array.isArray(value) ? value : [value]);

function collectCompanyRefs(req) {
  const ids = [];
  const names = [];

  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : null;

  for (const source of [req.query, body]) {
    if (!source) continue;
    for (const key of ID_KEYS) {
      if (source[key] !== undefined) ids.push(...flatten(source[key]));
    }
    for (const key of NAME_KEYS) {
      if (source[key] !== undefined) names.push(...flatten(source[key]));
    }
  }

  if (req.headers["x-company-id"] !== undefined) {
    ids.push(req.headers["x-company-id"]);
  }

  const isScalar = (v) => typeof v === "string" || typeof v === "number";
  const clean = (list) =>
    list.map((v) => String(v).trim()).filter((v) => !EMPTY_VALUES.has(v));

  return {
    ids: clean(ids.filter(isScalar)),
    names: clean(names.filter(isScalar)),
    // Objects/booleans (e.g. ?company_id[a]=99, {"company_id": true}) aren't
    // valid company references — reject instead of letting them reach SQL.
    invalid: [...ids, ...names].some((v) => v !== null && v !== undefined && !isScalar(v)),
  };
}

// Returns an { code, message } error, or null when every id is accessible.
function checkIds(access, ids) {
  for (const raw of ids) {
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      return { code: 400, message: `Invalid company id: "${raw}"` };
    }
    if (!access.ids.has(Number(raw))) {
      return { code: 403, message: "You don't have access to this company" };
    }
  }
  return null;
}

function checkNames(access, names) {
  for (const raw of names) {
    if (access.byName.has(normalizeName(raw))) continue;
    // Some callers send the numeric id in the `company` field.
    if (/^\d+$/.test(raw) && access.ids.has(Number(raw))) continue;
    return { code: 403, message: "You don't have access to this company" };
  }
  return null;
}

// Every reference on one request must point at the SAME company. Both may be
// the caller's own and still disagree (company_id=10 with company="Beta Co"
// = company 11) — routes store the id but push to Tally by the name, so the
// entry would land in the wrong company's books.
function checkConsistent(access, ids, names) {
  const distinctIds = new Set(ids.map(Number));
  if (distinctIds.size > 1) {
    return { code: 400, message: "Request refers to more than one company" };
  }
  const [id] = distinctIds;
  if (id === undefined) {
    // Names only: they must all resolve to at least one common company.
    let common = null;
    for (const raw of names) {
      const set = access.idsByName?.get(normalizeName(raw)) || new Set([Number(raw)]);
      common = common ? new Set([...common].filter((x) => set.has(x))) : set;
    }
    return common && common.size === 0
      ? { code: 400, message: "Request refers to more than one company" }
      : null;
  }
  for (const raw of names) {
    const set = access.idsByName?.get(normalizeName(raw));
    const matches = set ? set.has(id) : Number(raw) === id;
    if (!matches) {
      return { code: 400, message: "Company id and company name refer to different companies" };
    }
  }
  return null;
}

const isSkipped = (url) => {
  const path = url.split("?")[0].toLowerCase();
  return SKIP_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
};

/**
 * Express middleware: mount after requireSessionOrApiKey(). Requests that
 * carry no company reference pass straight through (their routes are
 * either not company-scoped or scope by record id — those check access
 * themselves via assertCompanyAccess / ownedCompaniesSql).
 */
export const requireCompanyAccess = async (req, res, next) => {
  try {
    if (isSkipped(req.originalUrl)) return next();

    const { ids, names, invalid } = collectCompanyRefs(req);
    if (invalid) return deny(res, 400, "Invalid company reference");
    if (!ids.length && !names.length) return next();

    const access = await getCompanyAccess(req);
    if (!access) return deny(res, 401, "Unauthenticated");

    const error =
      checkIds(access, ids) ||
      checkNames(access, names) ||
      checkConsistent(access, ids, names);
    if (error) return deny(res, error.code, error.message);

    return next();
  } catch (err) {
    return next(err);
  }
};

/**
 * For `router.param("companyId", companyParamGuard)` — path params aren't
 * known yet when app-level middleware runs.
 */
export const companyParamGuard = async (req, res, next, value) => {
  try {
    const access = await getCompanyAccess(req);
    if (!access) return deny(res, 401, "Unauthenticated");

    const error = checkIds(access, [String(value).trim()]);
    if (error) return deny(res, error.code, error.message);

    return next();
  } catch (err) {
    return next(err);
  }
};

/**
 * Route-level check for handlers that only learn the company after the
 * app-level guard ran (multipart bodies, or a company_id read off a record
 * fetched by its own id). Sends the error response and returns false when
 * access is denied.
 */
export async function assertCompanyAccess(req, res, companyId) {
  const access = await getCompanyAccess(req);
  if (!access) {
    deny(res, 401, "Unauthenticated");
    return false;
  }
  const error = checkIds(access, [String(companyId ?? "").trim()]);
  if (error) {
    deny(res, error.code, error.message);
    return false;
  }
  return true;
}

/**
 * Full guard check (ownership + id/name consistency) for bodies the
 * app-level guard couldn't see, e.g. multipart uploads. Sends the error
 * response and returns false when denied.
 */
export async function assertCompanyRefs(req, res, { ids = [], names = [] }) {
  const access = await getCompanyAccess(req);
  if (!access) {
    deny(res, 401, "Unauthenticated");
    return false;
  }
  const clean = (list) =>
    list
      .filter((v) => typeof v === "string" || typeof v === "number")
      .map((v) => String(v).trim())
      .filter((v) => !EMPTY_VALUES.has(v));
  const idList = clean(ids);
  const nameList = clean(names);
  const error =
    checkIds(access, idList) ||
    checkNames(access, nameList) ||
    checkConsistent(access, idList, nameList);
  if (error) {
    deny(res, error.code, error.message);
    return false;
  }
  return true;
}

/**
 * Resolves a company name to the caller's own company id (never another
 * tenant's company that happens to share the name). Null when not found.
 */
export async function resolveOwnedCompanyByName(req, name) {
  const access = await getCompanyAccess(req);
  if (!access || name == null) return null;
  return access.byName.get(normalizeName(name)) ?? null;
}

/**
 * SQL fragment restricting a company_id column to the caller's companies,
 * for UPDATE/SELECT statements keyed by a record id.
 * Usage: `... AND company_id IN (${ownedCompaniesSql("$3")})` with userId as $3.
 */
export const ownedCompaniesSql = (userParam) => `
  SELECT company_id
  FROM ${DB_SCHEMA}.connector_pairing_tokens
  WHERE user_id = ${userParam}
    AND is_used = TRUE
    AND company_id IS NOT NULL
`;
