import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { sendToTallyViaConnector } from "./connectorSync.service.js";
import { resolveTallyOwner } from "./connectorOwner.service.js";
import { getVoucherNumbersByTypeXML } from "./xmlBuilder.js";
import { parseXML } from "./parser.js";
import { normalizeNumbering, modeNeedsAppNumber } from "./companyProfileRules.js";
import { nextAfter, pickInvoiceNumber } from "./voucherNumberRules.js";

/*
  Voucher numbers for Tally voucher types that don't number themselves on
  import. Tally only auto-numbers types set to plain "Automatic"; "Manual" and
  "Automatic (Manual Override)" types put a push with an empty VOUCHERNUMBER
  into Import Exceptions ("Voucher No. is missing").

  The next number is the highest trailing number seen for that type among the
  synced Tally vouchers and the numbers this app already assigned, +1, keeping
  the prefix/suffix/zero-padding of that highest voucher (e.g. "FR/0042" ->
  "FR/0043"). The sync is the source of truth, so run a voucher sync before a
  push if people also enter vouchers in Tally directly.
*/

export function needsAppNumber(numberingMethod) {
  // Manual and "Automatic (Manual Override)" need a number from the app. Automatic, the built-in
  // "Default" and "None" don't, and an unknown/empty value is left to Tally as before.
  return modeNeedsAppNumber(normalizeNumbering(numberingMethod));
}

export { nextAfter };

// Indian financial year (1 Apr - 31 Mar) containing the voucher date, as the
// YYYYMMDD strings Tally wants. Numbering restarts per financial year.
function financialYearRange(voucherDate) {
  let y, m;
  if (voucherDate instanceof Date) {
    y = voucherDate.getFullYear();
    m = voucherDate.getMonth() + 1;
  } else {
    const s = String(voucherDate || "").slice(0, 10);
    const d = /^(\d{4})-(\d{2})/.exec(s);
    if (d) { y = Number(d[1]); m = Number(d[2]); }
    else { const now = new Date(); y = now.getFullYear(); m = now.getMonth() + 1; }
  }
  const start = m >= 4 ? y : y - 1;
  return { from: `${start}0401`, to: `${start + 1}0331` };
}

/*
  Live "voucher numbers only" resync: asks Tally (through the user's connector)
  for the numbers of this voucher type right now, so the next number accounts
  for vouchers entered in Tally after the last full sync. Returns null if the
  connector/Tally can't answer, and the caller falls back to the synced copy.
*/
async function fetchLiveNumbers(voucher, typeName) {
  try {
    const owner = await resolveTallyOwner(voucher.company_id, voucher.user_id);
    const { from, to } = financialYearRange(voucher.voucher_date);
    const xml = getVoucherNumbersByTypeXML(owner.companyName || voucher.company_name, typeName, from, to);
    const responseXml = await sendToTallyViaConnector(voucher.company_id, xml, "sync", owner.ownerUserId);
    const parsed = await parseXML(responseXml);
    const raw = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.VOUCHER;
    if (raw === undefined) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const numbers = [];
    for (const v of list) {
      let n = v?.VOUCHERNUMBER ?? v?.$?.VOUCHERNUMBER;
      if (Array.isArray(n)) n = n[0];
      if (n && typeof n === "object") n = n._ ?? null;
      if (n !== null && n !== undefined && String(n).trim()) numbers.push(String(n).trim());
    }
    return numbers;
  } catch (err) {
    console.warn(`[VOUCHER] ${voucher.id}: live voucher-number lookup failed (${err.message}) — using the last synced numbers`);
    return null;
  }
}

/*
  Assigns (and saves) a voucher number to a push row when its Tally voucher
  type needs one. Returns the number to use ("" when none is needed).
  Serialised per company + type name so two pushes can't get the same number.
*/
export async function ensureVoucherNumber(voucher) {
  const existing = String(voucher.voucher_number || "").trim();
  const typeName = String(voucher.voucher_type_name || "").trim();
  if (existing || !typeName) return existing;

  const vt = await pool.query(
    `SELECT numbering_method FROM ${DB_SCHEMA}.voucher_types
      WHERE company_id = $1 AND LOWER(TRIM(name)) = LOWER($2)`,
    [voucher.company_id, typeName]
  );
  if (!vt.rows.length || !needsAppNumber(vt.rows[0].numbering_method)) return "";

  // Taken before the DB lock so nothing is held open while the connector answers.
  const live = await fetchLiveNumbers(voucher, typeName);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`vchno:${voucher.company_id}:${typeName.toLowerCase()}`]
    );

    // Someone may have numbered this row while we waited for the lock
    const again = await client.query(
      `SELECT voucher_number FROM ${DB_SCHEMA}.contra_vouchers WHERE id = $1`,
      [voucher.id]
    );
    const already = String(again.rows[0]?.voucher_number || "").trim();
    if (already) {
      await client.query("COMMIT");
      return already;
    }

    // Live Tally numbers when available, otherwise the last synced copy.
    const synced = live
      ? { rows: live.map(n => ({ voucher_number: n })) }
      : await client.query(
          `SELECT voucher_number FROM ${DB_SCHEMA}.vouchers
            WHERE company_id = $1 AND LOWER(TRIM(voucher_type)) = LOWER($2)
              AND deleted_at IS NULL AND voucher_number IS NOT NULL`,
          [voucher.company_id, typeName]
        );
    const assigned = await client.query(
      `SELECT voucher_number FROM ${DB_SCHEMA}.contra_vouchers
        WHERE company_id = $1 AND LOWER(TRIM(voucher_type_name)) = LOWER($2)
          AND voucher_number IS NOT NULL AND voucher_number <> ''`,
      [voucher.company_id, typeName]
    );

    const number = nextAfter([
      ...synced.rows.map(r => r.voucher_number),
      ...assigned.rows.map(r => r.voucher_number)
    ]);

    await client.query(
      `UPDATE ${DB_SCHEMA}.contra_vouchers SET voucher_number = $1, updated_at = NOW() WHERE id = $2`,
      [number, voucher.id]
    );
    await client.query("COMMIT");
    console.log(`[VOUCHER] ${voucher.id}: assigned ${typeName} voucher no. ${number} (${live ? `live from Tally, ${live.length} existing` : "from last sync"})`);
    return number;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/*
  The same for sales and purchase invoices. Their rows have no voucher_number column, so the
  number the app assigns is kept inside raw_json as assigned_voucher_number (a retry reuses it).
  Returns "" when the Tally type numbers itself, otherwise the number to send as VOUCHERNUMBER.
  The supplier's own invoice number is a different thing: it stays in REFERENCE.
*/
const INVOICE_TABLES = new Set(["sales_invoice_extractions", "invoice_extractions"]);

export async function ensureInvoiceVoucherNumber({ table, row, typeName }) {
  if (!INVOICE_TABLES.has(table)) throw new Error(`ensureInvoiceVoucherNumber: unsupported table "${table}"`);
  if (!typeName) return "";

  const vt = await pool.query(
    `SELECT numbering_method FROM ${DB_SCHEMA}.voucher_types
      WHERE company_id = $1 AND LOWER(TRIM(name)) = LOWER($2)`,
    [row.company_id, typeName]
  );
  if (!vt.rows.length || !needsAppNumber(vt.rows[0].numbering_method)) return "";

  // Taken before the DB lock so nothing is held open while the connector answers.
  const live = await fetchLiveNumbers(
    { id: row.id, company_id: row.company_id, user_id: row.user_id, voucher_date: row.invoice_date, company_name: row.company_name },
    typeName
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`vchno:${row.company_id}:${typeName.toLowerCase()}`]);

    const current = await client.query(
      `SELECT raw_json->>'assigned_voucher_number' AS n FROM ${DB_SCHEMA}.${table} WHERE id = $1`,
      [row.id]
    );
    const existing = String(current.rows[0]?.n || "").trim();

    const synced = live
      ? []
      : (await client.query(
          `SELECT voucher_number FROM ${DB_SCHEMA}.vouchers
            WHERE company_id = $1 AND LOWER(TRIM(voucher_type)) = LOWER($2)
              AND deleted_at IS NULL AND voucher_number IS NOT NULL`,
          [row.company_id, typeName]
        )).rows.map(r => r.voucher_number);
    const assigned = (await client.query(
      `SELECT raw_json->>'assigned_voucher_number' AS n FROM ${DB_SCHEMA}.${table}
        WHERE company_id = $1 AND raw_json->>'assigned_voucher_number' IS NOT NULL`,
      [row.company_id]
    )).rows.map(r => r.n);

    const { number, reused } = pickInvoiceNumber({ existing, live, synced, assigned });

    if (!reused) {
      await client.query(
        `UPDATE ${DB_SCHEMA}.${table}
            SET raw_json = jsonb_set(COALESCE(raw_json, '{}'::jsonb), '{assigned_voucher_number}', to_jsonb($1::text)), updated_at = NOW()
          WHERE id = $2`,
        [number, row.id]
      );
    }
    await client.query("COMMIT");
    console.log(`[VOUCHER] ${table} ${row.id}: ${reused ? "reusing" : "assigned"} ${typeName} voucher no. ${number}${live ? " (live from Tally)" : " (from last sync)"}`);
    return number;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
