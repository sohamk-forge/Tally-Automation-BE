/**
 * voucherPdf.service.js
 * ======================
 * Pure data-shaping logic: takes a raw row from app_test.vouchers
 * (columns: id, company_name, voucher_date, voucher_type, voucher_number,
 * party_ledger_name, narration, debit_amount, credit_amount, balance,
 * parent_group, guid, master_id, alter_id, company_id, ledger_entries jsonb)
 * and returns the view-model each PDF template needs.
 */

/** Maps voucher_type text to the EJS template key. Keyword match, not exact,
 *  since Tally installs sometimes rename voucher types (e.g. "Bank Payment"). */
export function detectTemplateKey(voucherType = "") {
  const t = String(voucherType).toLowerCase();
  if (t.includes("contra")) return "contra";
  if (t.includes("journal")) return "journal";
  if (t.includes("payment")) return "payment";
  if (t.includes("receipt")) return "receipt";
  if (t.includes("purchase")) return "purchase";
  if (t.includes("sales") || t.includes("tax invoice")) return "sales";
  return null;
}

function pick(obj, keys, fallback = undefined) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return fallback;
}

function toNumber(v) {
  const n = parseFloat(String(v ?? "0").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function formatDate(dateValue) {
  if (!dateValue) return "";
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return String(dateValue);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${dd}-${months[d.getUTCMonth()]}-${yy}`;
}

/**
 * ledger_entries jsonb can hold debit/credit ledger lines (Contra, Journal,
 * Payment, Receipt) or stock-item lines (Purchase, Sales). Field names are
 * best-guess based on common Tally-sync naming - if your real jsonb uses
 * different keys, just add them to the pick(...) lists below.
 */
function parseLedgerLines(ledgerEntries) {
  const list = Array.isArray(ledgerEntries)
    ? ledgerEntries
    : ledgerEntries?.ledgers || ledgerEntries?.lines || [];

  return list.map((e) => {
    const amount = toNumber(pick(e, ["amount", "AMOUNT", "value"], 0));
    const debitFlag = pick(e, ["is_debit", "isDebit", "deemed_positive", "ISDEEMEDPOSITIVE"]);
    const isDebit =
      typeof debitFlag === "boolean"
        ? debitFlag
        : String(debitFlag).toLowerCase() === "yes" || String(debitFlag).toLowerCase() === "true";
    return {
      ledgerName: pick(e, ["ledger_name", "ledgerName", "LEDGERNAME", "name"], ""),
      debit: isDebit ? Math.abs(amount) : 0,
      credit: !isDebit ? Math.abs(amount) : 0,
    };
  });
}

function parseItemLines(ledgerEntries) {
  const list = Array.isArray(ledgerEntries)
    ? ledgerEntries
    : ledgerEntries?.items || ledgerEntries?.stock_items || [];

  return list
    .filter((e) => pick(e, ["stock_item", "stockItemName", "item_name", "description"]) !== undefined)
    .map((e) => ({
      stockItemName: pick(e, ["stock_item", "stockItemName", "item_name", "description"], ""),
      hsnSac: pick(e, ["hsn", "hsn_sac", "hsnSac"], ""),
      quantity: pick(e, ["quantity", "qty", "actual_qty"], ""),
      rate: toNumber(pick(e, ["rate"], 0)),
      unit: pick(e, ["unit", "uom", "per"], ""),
      amount: toNumber(pick(e, ["amount"], 0)),
    }));
}

/** Converts a raw vouchers row into the shape templates/*.ejs expect. */
export function normalizeVoucherRow(row, companyInfo) {
  const templateKey = detectTemplateKey(row.voucher_type);

  const base = {
    id: row.id,
    templateKey,
    voucherType: row.voucher_type,
    voucherNumber: row.voucher_number,
    date: formatDate(row.voucher_date),
    narration: row.narration || "",
    partyName: row.party_ledger_name || "",
    company: companyInfo,
  };

  if (templateKey === "contra" || templateKey === "journal") {
    let ledgerEntries = parseLedgerLines(row.ledger_entries);
    if (ledgerEntries.length === 0) {
      // Fallback: reconstruct the two legs from the voucher-level columns
      ledgerEntries = [
        { ledgerName: row.parent_group || "Cash", debit: toNumber(row.debit_amount), credit: 0 },
        { ledgerName: row.party_ledger_name || "", debit: 0, credit: toNumber(row.credit_amount) },
      ];
    }
    const total = ledgerEntries.reduce((sum, e) => sum + e.debit, 0) || toNumber(row.debit_amount);
    return { ...base, bankAccount: row.parent_group || "", ledgerEntries, total };
  }

  if (templateKey === "payment" || templateKey === "receipt") {
    const amount = toNumber(row.debit_amount) || toNumber(row.credit_amount);
    const closingBalance = toNumber(row.balance);
    // Payment reduces the ledger balance, Receipt increases it, so the
    // opening balance is derived the opposite way for each. Adjust if your
    // `balance` column means something other than "closing balance after
    // this transaction".
    const openingBalance =
      templateKey === "payment" ? closingBalance + amount : closingBalance - amount;
    return {
      ...base,
      bankAccount: row.parent_group || "",
      amount,
      openingBalance,
      closingBalance,
    };
  }

  if (templateKey === "purchase" || templateKey === "sales") {
    let items = parseItemLines(row.ledger_entries);
    const cgst = toNumber(row.ledger_entries?.cgst) || 0;
    const sgst = toNumber(row.ledger_entries?.sgst) || 0;
    if (items.length === 0) {
      // Fallback: no itemized lines available, show one summary line
      items = [
        {
          stockItemName: row.narration || row.party_ledger_name || "Item",
          hsnSac: "",
          quantity: "",
          rate: 0,
          unit: "",
          amount: toNumber(row.debit_amount) || toNumber(row.credit_amount),
        },
      ];
    }
    const total = items.reduce((sum, i) => sum + i.amount, 0);
    return {
      ...base,
      supplierInvoiceNo: pick(row.ledger_entries, ["supplier_invoice_no", "reference"], ""),
      buyerOrderNo: pick(row.ledger_entries, ["buyer_order_no"], ""),
      supplierOrBuyerName: row.party_ledger_name || "",
      supplierOrBuyerAddress: pick(row.ledger_entries, ["address"], ""),
      gstin: pick(row.ledger_entries, ["gstin", "party_gstin"], ""),
      placeOfSupply: pick(row.ledger_entries, ["place_of_supply"], companyInfo.state),
      items,
      total,
      cgst,
      sgst,
    };
  }

  return { ...base, raw: row };
}
