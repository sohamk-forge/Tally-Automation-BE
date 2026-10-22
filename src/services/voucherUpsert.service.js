/**
 * voucherUpsert.service.js
 * ------------------------
 * Single-voucher versions of what /voucher-sync and /sales-invoice-details-sync
 * do for a whole date range (sync.routes.js). Used by "send to Tally and print"
 * to pull one just-created Sales voucher back into app_test.vouchers so the
 * existing voucher PDF can be rendered from it.
 *
 * buildDeliveryNotes() is shared with sync.routes.js. The INSERT mirrors
 * voucher-sync's column list and its ON CONFLICT (company_id, guid) key, so a
 * later full sync updates the same row rather than adding a duplicate; if a
 * column is added to the voucher-sync INSERT, add it here too. It does not
 * write sales_items — the full sync owns that table.
 */
import { DB_SCHEMA } from "../config/db.js";
import { applyVoucherDelta, bumpBalancesVersion } from "./balanceRefresh.service.js";

export const cleanText = (value) => {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/&#13;&#10;|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const toList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/** LASTVCHID (master ID of the voucher just created) from an import response, or null. */
export function parseLastVoucherId(responseXml) {
  const id = String(responseXml || "").match(/<LASTVCHID>\s*(\d+)\s*<\/LASTVCHID>/)?.[1];
  return id && id !== "0" ? id : null;
}

/** First VOUCHER node out of a parsed Collection export, or null. */
export function firstVoucherNode(parsed) {
  const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.VOUCHER;
  return toList(collection)[0] || null;
}

/** "20261017" -> "2026-10-17" (unchanged when it isn't YYYYMMDD). */
export function tallyDateToIso(value) {
  return cleanText(value)?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") ?? null;
}

/** The printed-invoice dispatch/delivery block; same keys sync.routes.js writes. */
export function buildDeliveryNotes(voucher) {
  return {
    reference_no: cleanText(voucher?.REFERENCE),
    reference_date: cleanText(voucher?.REFERENCEDATE),
    other_references: cleanText(voucher?.OTHERREFERENCE),
    mode_terms_of_payment: cleanText(voucher?.BASICDUEDATEOFPYMT),
    buyers_order_no: cleanText(voucher?.BASICPURCHASEORDERNO),
    buyers_order_date: cleanText(voucher?.BASICORDERDATE),
    order_reference: cleanText(voucher?.BASICORDERREF),
    delivery_note: cleanText(voucher?.BASICSHIPDELIVERYNOTE),
    delivery_note_date: cleanText(voucher?.BASICSHIPPINGDATE),
    dispatch_doc_no: cleanText(voucher?.BASICSHIPDOCUMENTNO),
    dispatched_through: cleanText(voucher?.BASICSHIPPEDBY),
    vessel_no: cleanText(voucher?.BASICSHIPVESSELNO),
    vessel_date: cleanText(voucher?.BASICSHIPVESSELDATE),
    destination: cleanText(voucher?.BASICSHIPDESTINATION),
    final_destination: cleanText(voucher?.BASICFINALDESTINATION),
    terms_of_delivery: cleanText(voucher?.BASICSHIPDELIVERYTERMS)
  };
}

/**
 * Upserts one voucher node (from getLedgerVoucherByMasterIdXML) into
 * app_test.vouchers and returns { id, voucherNumber, guid }.
 */
export async function upsertSingleVoucher(db, { voucher, company, companyId }) {
  const guid = cleanText(voucher?.GUID);
  if (!guid) {
    throw new Error("Tally returned the voucher without a GUID — cannot store it safely");
  }

  const entries = toList(voucher?.["ALLLEDGERENTRIES.LIST"]);
  const voucherNumber = cleanText(voucher?.VOUCHERNUMBER);
  const voucherDate = tallyDateToIso(voucher?.DATE);
  const voucherTypeName = cleanText(voucher?.VOUCHERTYPENAME);
  const partyLedgerName = cleanText(voucher?.PARTYLEDGERNAME);

  // Same debit/credit derivation as voucher-sync: the party leg decides.
  let debitAmount = 0;
  let creditAmount = 0;
  const partyEntry = entries.find((e) => cleanText(e?.LEDGERNAME) === partyLedgerName);
  if (partyEntry) {
    const amount = Number(partyEntry?.AMOUNT || 0);
    if (amount < 0) debitAmount = Math.abs(amount);
    else creditAmount = amount;
  }

  const yesNo = (v) => (cleanText(v) == null ? null : /^yes$/i.test(cleanText(v)));
  const referenceDate = cleanText(voucher?.REFERENCEDATE);

  const result = await db.query(
    `
    INSERT INTO ${DB_SCHEMA}.vouchers (
      guid, master_id, alter_id, company_id, company_name,
      voucher_date, voucher_type, voucher_number, party_ledger_name,
      narration, ledger_entries, debit_amount, credit_amount, balance,
      supplier_invoice_no, supplier_invoice_date, party_gstin, place_of_supply,
      is_cancelled, is_optional, created_at, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW(),NOW())
    ON CONFLICT (company_id, guid) WHERE guid IS NOT NULL AND guid <> ''
    DO UPDATE SET
      master_id = EXCLUDED.master_id,
      alter_id = EXCLUDED.alter_id,
      voucher_date = EXCLUDED.voucher_date,
      voucher_number = EXCLUDED.voucher_number,
      voucher_type = EXCLUDED.voucher_type,
      party_ledger_name = EXCLUDED.party_ledger_name,
      narration = EXCLUDED.narration,
      ledger_entries = EXCLUDED.ledger_entries,
      debit_amount = EXCLUDED.debit_amount,
      credit_amount = EXCLUDED.credit_amount,
      balance = EXCLUDED.balance,
      supplier_invoice_no = EXCLUDED.supplier_invoice_no,
      supplier_invoice_date = EXCLUDED.supplier_invoice_date,
      party_gstin = EXCLUDED.party_gstin,
      place_of_supply = EXCLUDED.place_of_supply,
      is_cancelled = EXCLUDED.is_cancelled,
      is_optional = EXCLUDED.is_optional,
      deleted_at = NULL,
      updated_at = NOW()
    RETURNING id
    `,
    [
      guid,
      cleanText(voucher?.MASTERID) || null,
      Number(cleanText(voucher?.ALTERID) || 0),
      companyId,
      company,
      voucherDate,
      voucherTypeName,
      voucherNumber,
      partyLedgerName,
      cleanText(voucher?.NARRATION),
      JSON.stringify(entries),
      debitAmount,
      creditAmount,
      debitAmount - creditAmount,
      cleanText(voucher?.REFERENCE) || null,
      referenceDate && /^\d{8}$/.test(referenceDate) ? tallyDateToIso(referenceDate) : null,
      cleanText(voucher?.PARTYGSTIN)?.toUpperCase() || null,
      cleanText(voucher?.PLACEOFSUPPLY) || null,
      yesNo(voucher?.ISCANCELLED),
      yesNo(voucher?.ISOPTIONAL)
    ]
  );

  return { id: result.rows[0].id, voucherNumber, guid };
}

// Cancelled and optional vouchers don't post to ledgers in Tally.
const postsToLedgers = (v) => !(v?.is_cancelled || v?.is_optional);

/**
 * upsertSingleVoucher plus the balance snapshots (balanceRefresh.service.js), in one
 * transaction. Every path that stores a just-posted voucher goes through this, so
 * whichever runs first moves the balances and the others see an unchanged voucher
 * (delta 0). Takes the pool and owns the transaction.
 */
export async function upsertVoucherAndRefreshBalances(pool, { voucher, company, companyId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const guid = cleanText(voucher?.GUID);

    // A voucher that is not in the table yet has no row for FOR UPDATE to lock, so the
    // print worker and the post-invoice refresh worker (both queued by one push) could
    // each see "new voucher" and each apply the full balance delta: every ledger moved
    // twice. Serialise per voucher so the second one sees the first one's committed row
    // and applies a delta of 0.
    if (guid) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`voucher:${companyId}:${guid}`]);
    }

    const existing = guid
      ? (
          await client.query(
            `SELECT ledger_entries, is_cancelled, is_optional
             FROM ${DB_SCHEMA}.vouchers WHERE company_id = $1 AND guid = $2 FOR UPDATE`,
            [companyId, guid]
          )
        ).rows[0]
      : null;

    const saved = await upsertSingleVoucher(client, { voucher, company, companyId });

    const yesNo = (v) => cleanText(v) != null && /^yes$/i.test(cleanText(v));
    const newPosts = !(yesNo(voucher?.ISCANCELLED) || yesNo(voucher?.ISOPTIONAL));

    // The balance update is best-effort: if it fails (e.g. migration not applied yet) the
    // voucher is still stored, so printing and LedgerDetail keep working and the next
    // full sync corrects the balances.
    let ledgersUpdated = 0;
    await client.query("SAVEPOINT balance_refresh");
    try {
      ({ ledgersUpdated } = await applyVoucherDelta(client, {
        companyId,
        oldEntries: existing && postsToLedgers(existing) ? existing.ledger_entries : [],
        newEntries: newPosts ? voucher?.["ALLLEDGERENTRIES.LIST"] : []
      }));
      if (ledgersUpdated > 0) await bumpBalancesVersion(client, companyId);
      await client.query("RELEASE SAVEPOINT balance_refresh");
    } catch (balanceError) {
      await client.query("ROLLBACK TO SAVEPOINT balance_refresh");
      ledgersUpdated = 0;
      console.error("[BALANCE-REFRESH] Skipped, voucher stored without balance update:", balanceError.message);
    }

    await client.query("COMMIT");
    return { ...saved, ledgersUpdated };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
