// Last-line guardrail against Tally's "Referenced master is missing" import
// exception (Gateway of Tally > Import Exceptions).
//
// Tally accepts a voucher import only if EVERY ledger / stock item / godown it
// names already exists in the target company. Otherwise the voucher is
// rejected with LINEERROR "Ledger 'X' does not exist!" and lands in Import
// Exceptions. The per-worker validators check the invoice's JSON against our
// cached copy of Tally's masters, but they cannot see what the XML generators
// actually emit: per-line ledger overrides, the round-off ledger the Python
// generator adds when a voucher doesn't balance, blank mappings, hard-coded
// fallbacks ("Sales", "CGST", "Round Off"), godowns, and the Payment /
// Receipt / Contra workers had no master check at all.
//
// So this guard validates the generated XML itself, right before a connector
// job is created. Whatever would be sent to Tally is exactly what is checked.
//
//   - Missing masters  -> block the push (nothing reaches Tally).
//   - Blank master tag -> block the push (a blank mapping, e.g. <LEDGERNAME/>).
//   - Name differs from the real master only by whitespace/case -> the XML is
//     repaired to the exact Tally spelling instead of being rejected.
//
// Set DISABLE_MASTERS_GUARD=1 to bypass (emergency kill-switch only).

import { DB_SCHEMA } from "../config/db.js";
import { normName, pushedLedgerStillInTally, pushedStockItemStillInTally } from "../utils/masterSoftDelete.js";

// Tally's built-in godown — always present, never in our synced list.
const DEFAULT_GODOWN = "main location";

const MASTER_TAG = /<(LEDGERNAME|PARTYLEDGERNAME|STOCKITEMNAME|GODOWNNAME)(?:\s*\/>|\s*>([\s\S]*?)<\/\1\s*>)/g;

const TAG_KIND = {
  LEDGERNAME: "ledger",
  PARTYLEDGERNAME: "ledger",
  STOCKITEMNAME: "stockItem",
  GODOWNNAME: "godown"
};

const exactKey = (s) => String(s).trim().toLowerCase();
const looseKey = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");

export function decodeXmlText(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function escapeXmlText(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Every master the voucher XML references.
 * @returns {{ ledgers: string[], stockItems: string[], godowns: string[], blanks: string[] }}
 *   Names are decoded, trimmed, de-duplicated (case-insensitively). `blanks`
 *   lists the tag names that were empty.
 */
export function extractMasterRefs(xml) {
  const seen = { ledger: new Map(), stockItem: new Map(), godown: new Map() };
  const blanks = [];

  for (const match of String(xml || "").matchAll(MASTER_TAG)) {
    const tag = match[1];
    const name = decodeXmlText(match[2]).trim();
    if (!name) {
      blanks.push(tag);
      continue;
    }
    const bucket = seen[TAG_KIND[tag]];
    if (!bucket.has(exactKey(name))) bucket.set(exactKey(name), name);
  }

  return {
    ledgers: [...seen.ledger.values()],
    stockItems: [...seen.stockItem.values()],
    godowns: [...seen.godown.values()],
    blanks
  };
}

/**
 * Compare referenced names with the real master names found in the cache.
 *
 * `found` holds the real Tally spellings that matched each referenced name
 * loosely (case/whitespace-insensitive). A reference with an exact match is
 * fine; one that only matches loosely is repaired to the real spelling; one
 * with no match is missing. `found.godowns === null` means no godown list has
 * been synced for this company, so godowns can't be verified and are skipped.
 */
export function evaluateMasterRefs(refs, found) {
  const missingLedgers = [];
  const missingStockItems = [];
  const missingGodowns = [];
  const repairs = [];

  const check = (kind, names, realNames, missing) => {
    const exact = new Set(realNames.map(exactKey));
    const byLoose = new Map();
    for (const real of realNames) if (!byLoose.has(looseKey(real))) byLoose.set(looseKey(real), real);

    for (const name of names) {
      if (exact.has(exactKey(name))) continue;
      const real = byLoose.get(looseKey(name));
      if (real) repairs.push({ kind, from: name, to: real });
      else missing.push(name);
    }
  };

  check("ledger", refs.ledgers, found.ledgers || [], missingLedgers);
  check("stockItem", refs.stockItems, found.stockItems || [], missingStockItems);

  if (found.godowns) {
    const godowns = refs.godowns.filter((g) => exactKey(g) !== DEFAULT_GODOWN);
    check("godown", godowns, found.godowns, missingGodowns);
  }

  return {
    ok: !missingLedgers.length && !missingStockItems.length && !missingGodowns.length && !refs.blanks.length,
    missingLedgers,
    missingStockItems,
    missingGodowns,
    blanks: refs.blanks,
    repairs
  };
}

/** Rewrite repaired names in the XML to the exact spelling Tally has. */
export function applyRepairs(xml, repairs) {
  if (!repairs.length) return xml;

  return xml.replace(MASTER_TAG, (whole, tag, inner) => {
    if (inner === undefined) return whole;
    const decoded = decodeXmlText(inner).trim();
    const repair = repairs.find((r) => r.kind === TAG_KIND[tag] && r.from === decoded);
    return repair ? `<${tag}>${escapeXmlText(repair.to)}</${tag}>` : whole;
  });
}

/** Human-readable reason, mirroring the existing "Ledger not present: ..." wording. */
export function formatGuardMessage(result) {
  const parts = [];
  if (result.missingLedgers.length) parts.push(`Ledger not present: ${result.missingLedgers.join(", ")}`);
  if (result.missingStockItems.length) parts.push(`Stock item not present: ${result.missingStockItems.join(", ")}`);
  if (result.missingGodowns.length) parts.push(`Godown not present: ${result.missingGodowns.join(", ")}`);
  if (result.blanks.length) {
    parts.push(`Voucher has ${result.blanks.length} blank master field(s) (${[...new Set(result.blanks)].join(", ")}) — a ledger mapping is empty`);
  }
  return parts.join(" | ") || "Voucher failed master data validation";
}

/**
 * Failure shape for the invoice tables (sales_invoice_extractions /
 * invoice_extractions): the same sync_status values and error_message JSON
 * the workers already write, so the Missing screens keep working unchanged.
 */
export function buildInvoiceFailure(result) {
  const hasLedgers = result.missingLedgers.length > 0;
  const hasStock = result.missingStockItems.length > 0;
  const message = `${formatGuardMessage(result)} (blocked before reaching Tally)`;

  const syncStatus =
    hasLedgers && hasStock ? "ledger_and_stock_missing"
    : hasLedgers ? "ledger_missing"
    : hasStock ? "stock_missing"
    : "failed";

  return {
    syncStatus,
    message,
    errorMessage: JSON.stringify({
      message,
      validation_stage: "xml_master_guard",
      missing_ledgers: result.missingLedgers.map((ledger) => ({ field: "tally_ledger", ledger })),
      missing_stock_items: result.missingStockItems,
      missing_stock_item_details: {},
      missing_godowns: result.missingGodowns,
      blank_master_fields: result.blanks
    })
  };
}

// ---------------------------------------------------------------------------
// DB lookups against the synced master cache (same sources and soft-delete
// rules the workers' own ledgerExists / stockItemExists use).
// ---------------------------------------------------------------------------

export function createDbLookups(db) {
  const looseKeys = (names) => [...new Set(names.map(looseKey))];

  return {
    async ledgers(companyId, names) {
      if (!names.length) return [];
      const { rows } = await db.query(
        `
        SELECT ledger_name AS name FROM ${DB_SCHEMA}.all_ledger_details
        WHERE company_id = $1 AND deleted_at IS NULL AND ${normName("ledger_name")} = ANY($2::text[])
        UNION
        SELECT ledger_name AS name FROM ${DB_SCHEMA}.push_ledger pl
        WHERE company_id = $1 AND status = 'success' AND ${normName("ledger_name")} = ANY($2::text[])
          AND ${pushedLedgerStillInTally(DB_SCHEMA, "pl")}
        `,
        [companyId, looseKeys(names)]
      );
      return rows.map((r) => r.name);
    },

    async stockItems(companyId, names) {
      if (!names.length) return [];
      const { rows } = await db.query(
        `
        SELECT item_name AS name FROM ${DB_SCHEMA}.stock_group_summary
        WHERE company_id = $1 AND deleted_at IS NULL AND ${normName("item_name")} = ANY($2::text[])
        UNION
        SELECT item_name AS name FROM ${DB_SCHEMA}.push_stock_item psi
        WHERE company_id = $1 AND status = 'success' AND ${normName("item_name")} = ANY($2::text[])
          AND ${pushedStockItemStillInTally(DB_SCHEMA, "psi")}
        `,
        [companyId, looseKeys(names)]
      );
      return rows.map((r) => r.name);
    },

    // null = no godown list synced yet → can't verify, so don't block on it.
    async godowns(companyId) {
      const { rows } = await db.query(
        `SELECT godown_name AS name FROM ${DB_SCHEMA}.godown_details WHERE company_id = $1`,
        [companyId]
      );
      return rows.length ? rows.map((r) => r.name) : null;
    }
  };
}

/**
 * Validate (and where safe, repair) a voucher XML before it is queued for the
 * connector.
 *
 * @returns {Promise<{ok:boolean, skipped?:boolean, xml:string, repairs:object[],
 *   missingLedgers:string[], missingStockItems:string[], missingGodowns:string[], blanks:string[]}>}
 *   `xml` is the repaired XML to send when `ok`.
 */
export async function guardVoucherXml({ companyId, xml, db, lookups } = {}) {
  if (process.env.DISABLE_MASTERS_GUARD === "1") {
    return { ok: true, skipped: true, xml, repairs: [], missingLedgers: [], missingStockItems: [], missingGodowns: [], blanks: [] };
  }
  if (!companyId) throw new Error("guardVoucherXml: companyId is required");

  const resolvedLookups = lookups || createDbLookups(db || (await import("../db/index.js")).default);
  const refs = extractMasterRefs(xml);

  const [ledgers, stockItems, godowns] = await Promise.all([
    resolvedLookups.ledgers(companyId, refs.ledgers),
    resolvedLookups.stockItems(companyId, refs.stockItems),
    refs.godowns.length ? resolvedLookups.godowns(companyId) : Promise.resolve(null)
  ]);

  const result = evaluateMasterRefs(refs, { ledgers, stockItems, godowns });
  return { ...result, xml: result.ok ? applyRepairs(xml, result.repairs) : xml };
}
