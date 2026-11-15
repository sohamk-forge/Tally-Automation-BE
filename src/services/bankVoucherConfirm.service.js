/*
  Confirms a bank-statement voucher really landed in Tally.

  Tally's import reply can claim success without anything being created, so a
  row is only SUCCESS once the voucher is read back by the LASTVCHID Tally
  returned and its voucher number is in hand. The number is saved on every
  row of the voucher (clubbed / split parts share one). If it can't be
  confirmed the rows go to FAILED, where the user can re-push them.

  Not retried in a loop: one read-back, one retry on a transient error, then
  FAILED.
*/
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { sendToTallyViaConnector } from "./connectorSync.service.js";
import { resolveConnectorForCompany } from "./connectorOwner.service.js";
import { parseXMLKeepText } from "./parser.js";
import { getLedgerVoucherByMasterIdXML } from "./xmlBuilder.js";
import { firstVoucherNode, parseLastVoucherId, cleanText, upsertVoucherAndRefreshBalances } from "./voucherUpsert.service.js";
import { storeLedgerEmbedding } from "./ledgerEmbedding.js";

// pg hands DATE columns back as local-midnight Date objects; toISOString()
// would shift them to the previous day in IST and Tally's period filter would
// then miss the voucher, so read the local calendar parts instead.
const toTallyDate = (value) => {
  if (value instanceof Date) {
    const p = (n) => String(n).padStart(2, "0");
    return `${value.getFullYear()}${p(value.getMonth() + 1)}${p(value.getDate())}`;
  }
  const m = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
};

async function settle(ids, status, { voucherNumber = null, message = null } = {}) {
  await pool.query(
    `UPDATE ${DB_SCHEMA}.contra_vouchers
     SET status = $1,
         voucher_number = COALESCE($2, voucher_number),
         err_message = $3,
         updated_at = NOW()
     WHERE id = ANY($4::int[]) AND status = 'PENDING_CONNECTOR'`,
    [status, voucherNumber, message, ids]
  );
}

async function readVoucherNumber(row, masterId) {
  const connector = await resolveConnectorForCompany(row.company_id, row.user_id);
  if (!connector) throw new Error("No active connector found to verify the voucher in Tally");

  const day = toTallyDate(row.voucher_date);
  const xml = await sendToTallyViaConnector(
    row.company_id,
    getLedgerVoucherByMasterIdXML(row.company_name, masterId, day, day),
    "sync",
    connector.user_id
  );
  const voucher = firstVoucherNode(await parseXMLKeepText(xml, ["REFERENCE", "PARTYGSTIN"]));
  return voucher ? { number: cleanText(voucher.VOUCHERNUMBER) || null, voucher } : null;
}

/** ids: every contra_vouchers row backed by the one Tally voucher. */
export async function confirmBankVoucherInTally(ids) {
  const rowsRes = await pool.query(
    `SELECT * FROM ${DB_SCHEMA}.contra_vouchers
     WHERE id = ANY($1::int[]) AND status = 'PENDING_CONNECTOR'
     ORDER BY id ASC`,
    [ids]
  );
  const rows = rowsRes.rows;
  if (!rows.length) return { status: "skipped" };
  // Rows Tally already rejected are FAILED with Tally's own error; leave those.
  const leader = rows[0];

  const masterId = parseLastVoucherId(leader.tally_response);
  if (!masterId) {
    await settle(ids, "FAILED", {
      message: "Tally did not return a voucher ID, so the voucher could not be confirmed. Check Tally, then re-push."
    });
    return { status: "failed", reason: "no_master_id" };
  }

  let number = null;
  let tallyVoucher = null;
  let lastError = null;
  // Tally can lag a moment before a just-imported voucher is readable, so a
  // few spaced attempts; still bounded, never a loop.
  for (let attempt = 0; attempt < 3 && !number; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 3000));
    try {
      const read = await readVoucherNumber(leader, masterId);
      number = read?.number || null;
      tallyVoucher = read?.voucher || null;
    } catch (err) {
      lastError = err.message;
    }
  }

  if (!number) {
    await settle(ids, "FAILED", {
      message:
        `Could not confirm the voucher in Tally (no voucher number found${lastError ? `: ${lastError}` : ""}). ` +
        "Check Tally, then re-push."
    });
    return { status: "failed", reason: "no_voucher_number" };
  }

  await settle(ids, "SUCCESS", { voucherNumber: number });

  // Update the app's ledger data from the voucher just read back: it goes into
  // app_test.vouchers (ledger statements, trends, ageing) and the ledger /
  // group balances move by its effect. Idempotent per voucher GUID. Best
  // effort: a failure here never un-confirms the voucher; the next full Tally
  // sync catches the pages up.
  try {
    await upsertVoucherAndRefreshBalances(pool, {
      voucher: tallyVoucher,
      company: leader.company_name,
      companyId: leader.company_id
    });
  } catch (e) {
    console.error(`Ledger refresh failed for bank voucher ${leader.id}:`, e.message);
  }

  // Embedding is only worth storing for a confirmed voucher; never blocks it.
  for (const r of rows) {
    storeLedgerEmbedding({
      companyId: r.company_id,
      companyName: r.company_name,
      groupKey: r.group_key,
      ledgerName: r.party_ledger
    }).catch((e) => console.error(`Embedding failed for voucher ${r.id}:`, e.message));
  }
  return { status: "success", voucherNumber: number };
}
