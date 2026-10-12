/**
 * Company names aren't unique (one companies row per user pairing), so a name
 * lookup can resolve to the wrong same-named row. Routes that still accept a
 * company name also accept the exact company_id; when it is present it wins.
 *
 * Ownership is not decided here: callers still join connector_pairing_tokens
 * on the acting user, so an id the user doesn't own simply won't match.
 */

/** Positive-integer company_id from the body/query (company_id or companyId), else null. */
export function requestedCompanyId(req) {
  const raw =
    req.body?.company_id ?? req.query?.company_id ??
    req.body?.companyId ?? req.query?.companyId;
  if (raw === undefined || raw === null || raw === "") return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * SQL predicate for a `companies c` row: match the id when one was given,
 * otherwise fall back to the case/whitespace-insensitive name.
 */
export const companyMatchSql = (nameParam, idParam) =>
  `(CASE WHEN ${idParam}::int IS NOT NULL
         THEN c.id = ${idParam}::int
         ELSE lower(trim(c.name)) = lower(trim(${nameParam}))
    END)`;
