import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { sendToTallyViaConnector } from "./connectorSync.service.js";
import { resolveTallyOwner } from "./connectorOwner.service.js";
import { getVoucherNumbersByTypeXML } from "./xmlBuilder.js";
import { parseXML } from "./parser.js";

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
  const m = String(numberingMethod || "").trim().toLowerCase();
  if (!m) return false; // unknown (not re-synced yet): leave Tally to number it
  return m !== "automatic";
}

function parseNumber(str) {
  const m = /^(.*?)(\d+)(\D*)$/.exec(String(str ?? "").trim());
  if (!m) return null;
  return { prefix: m[1], digits: m[2], suffix: m[3], value: Number(m[2]) };
}

export function nextAfter(numbers) {
  let best = null;
  for (const n of numbers) {
    const p = parseNumber(n);
    if (p && (!best || p.value > best.value)) best = p;
  }
  if (!best) return "1";
  const next = String(best.value + 1).padStart(best.digits.length, "0");
  return `${best.prefix}${next}${best.suffix}`;
}

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
