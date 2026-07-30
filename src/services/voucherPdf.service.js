/**
 * voucherPdf.service.js
 * ======================
 * Pure data-shaping logic: takes a raw row from app_test.vouchers
 * (columns: id, company_name, voucher_date, voucher_type, voucher_number,
 * party_ledger_name, narration, debit_amount, credit_amount, balance,
 * parent_group, guid, master_id, alter_id, company_id, ledger_entries jsonb)
 * and returns the view-model each PDF template needs.
 *
 * ledger_entries jsonb is the raw Tally export array, e.g.:
 * [
 *   { LEDGERNAME, AMOUNT, ISDEEMEDPOSITIVE, BILLALLOCATIONS.LIST, ... },
 *   { LEDGERNAME, AMOUNT, "INVENTORYALLOCATIONS.LIST": { STOCKITEMNAME, RATE, AMOUNT, ACTUALQTY, BILLEDQTY, ... } },
 *   ...
 * ]
 *
 * HSN/SAC codes are NOT read from ledger_entries. They are looked up from
 * the `stock_group_summary` table by stock item name, via the `hsnMap`
 * param passed into normalizeVoucherRow() (built by the route handler).
 */

// ---------- generic helpers ----------

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

/** Maps voucher_type text to the EJS/HTML template key. Keyword match, not
 *  exact, since Tally installs sometimes rename voucher types
 *  (e.g. "Bank Payment"). */
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

// ---------- small string parsers for Tally's "80.51/nos" / "60 nos" formats ----------

function toQtyUnit(qtyStr) {
  // "60 nos" -> { quantity: "60", unit: "nos" }
  const s = String(qtyStr || "").trim();
  const m = s.match(/^(-?[\d,.]+)\s*(.*)$/);
  if (!m) return { quantity: s, unit: "" };
  return { quantity: m[1], unit: m[2].trim() };
}

function toRateUnit(rateStr) {
  // "80.51/nos" -> { rate: 80.51, unit: "nos" }
  const s = String(rateStr || "").trim();
  const [numPart, unitPart] = s.split("/");
  return { rate: toNumber(numPart), unit: (unitPart || "").trim() };
}

// ---------- ledger (debit/credit) lines: Contra, Journal ----------

function parseLedgerLines(ledgerEntries) {
  const list = Array.isArray(ledgerEntries) ? ledgerEntries : [];

  return list.map((e) => {
    const amount = toNumber(pick(e, ["AMOUNT", "amount"], 0));
    const debitFlag = pick(e, ["ISDEEMEDPOSITIVE", "is_debit", "isDebit"]);
    const isDebit =
      typeof debitFlag === "boolean"
        ? debitFlag
        : String(debitFlag).toLowerCase() === "yes" || String(debitFlag).toLowerCase() === "true";
    return {
      ledgerName: pick(e, ["LEDGERNAME", "ledger_name", "ledgerName", "name"], ""),
      debit: isDebit ? Math.abs(amount) : 0,
      credit: !isDebit ? Math.abs(amount) : 0,
    };
  });
}

// ---------- item lines: nested under "INVENTORYALLOCATIONS.LIST" ----------

/**
 * @param {Array} ledgerEntries - raw ledger_entries jsonb array
 * @param {Object} hsnMap - { [stockItemName]: hsnCode } built from
 *   stock_group_summary by the route handler. HSN is looked up here by
 *   exact stock item name match; if not found, hsnSac is "".
 */
function parseItemLines(ledgerEntries, hsnMap = {}) {
  const list = Array.isArray(ledgerEntries) ? ledgerEntries : [];
  const items = [];

  for (const entry of list) {
    const invRaw =
      entry["INVENTORYALLOCATIONS.LIST"] ??
      entry.inventoryAllocations ??
      entry.inventory_allocations;
    if (!invRaw) continue;

    const invList = Array.isArray(invRaw) ? invRaw : [invRaw];

    for (const inv of invList) {
      const stockItemName = pick(inv, ["STOCKITEMNAME", "stockItemName", "stock_item"], "");
      if (!stockItemName) continue;

      const { rate, unit: rateUnit } = toRateUnit(pick(inv, ["RATE"], ""));
      const qtyRaw = pick(inv, ["BILLEDQTY", "ACTUALQTY"], "");
      const { quantity, unit: qtyUnit } = toQtyUnit(qtyRaw);

      // HSN/SAC comes exclusively from stock_group_summary, matched by item name.
      // (Any HSN-ish fields on the ledger_entries JSON itself are ignored.)
      const hsnSac = hsnMap[stockItemName] || "";

      items.push({
        stockItemName,
        hsnSac,
        quantity,
        rate,
        unit: rateUnit || qtyUnit || "",
        amount: Math.abs(toNumber(pick(inv, ["AMOUNT"], 0))),
      });
    }
  }

  return items;
}

// ---------- tax lines: flat entries named "CGST", "SGST", "Input IGST@18% (...)" etc ----------

function extractTaxTotals(ledgerEntries) {
  const list = Array.isArray(ledgerEntries) ? ledgerEntries : [];
  let cgst = 0, sgst = 0, igst = 0;

  for (const entry of list) {
    const name = String(pick(entry, ["LEDGERNAME", "ledgerName"], "")).toLowerCase();
    if (!name) continue;
    const amount = Math.abs(toNumber(pick(entry, ["AMOUNT"], 0)));

    if (name.includes("cgst")) cgst += amount;
    else if (name.includes("sgst") || name.includes("utgst")) sgst += amount;
    else if (name.includes("igst")) igst += amount;
  }

  return { cgst, sgst, igst };
}

// ---------- everything else that isn't the party, an item, a tax, or
//            round-off (e.g. "Handling Charges") gets its own line ----------

function extractAdditionalCharges(ledgerEntries, partyName) {
  const list = Array.isArray(ledgerEntries) ? ledgerEntries : [];
  const charges = [];

  for (const entry of list) {
    if (entry["INVENTORYALLOCATIONS.LIST"] || entry.inventoryAllocations) continue;

    const name = pick(entry, ["LEDGERNAME", "ledgerName"], "");
    if (!name || name === partyName) continue;

    const lower = name.toLowerCase();
    if (lower.includes("cgst") || lower.includes("sgst") || lower.includes("igst") || lower.includes("utgst")) continue;
    if (lower.includes("round off")) continue;

    charges.push({ label: name, amount: Math.abs(toNumber(pick(entry, ["AMOUNT"], 0))) });
  }

  return charges;
}

// ---------- multi-party breakdown: Payment/Receipt vouchers can have
//            several party ledger lines against one bank/cash line ----------

function parsePartyLines(ledgerEntries, bankOrCashLedgerName) {
  const list = Array.isArray(ledgerEntries) ? ledgerEntries : [];
  const parties = [];

  for (const entry of list) {
    const name = pick(entry, ["LEDGERNAME", "ledgerName"], "");
    if (!name || name === bankOrCashLedgerName) continue;
    parties.push({
      partyName: name,
      amount: Math.abs(toNumber(pick(entry, ["AMOUNT"], 0))),
    });
  }

  return parties;
}

function findBankOrCashLine(ledgerEntries) {
  const list = Array.isArray(ledgerEntries) ? ledgerEntries : [];
  // The bank/cash leg is the one with the largest absolute amount and no
  // inventory allocation (heuristic: in Tally payment/receipt vouchers the
  // bank/cash ledger is usually the single counter-entry to N party lines).
  let best = null;
  for (const entry of list) {
    if (entry["INVENTORYALLOCATIONS.LIST"]) continue;
    const amount = Math.abs(toNumber(pick(entry, ["AMOUNT"], 0)));
    if (!best || amount > best.amount) {
      best = { name: pick(entry, ["LEDGERNAME", "ledgerName"], ""), amount };
    }
  }
  return best;
}

/**
 * Converts a raw vouchers row into the shape templates expect.
 *
 * @param {Object} row - raw row from app_test.vouchers
 * @param {Object} companyInfo - from companyInfo.service.js
 * @param {Object} hsnMap - { [stockItemName]: hsnCode }, built by the route
 *   handler from the stock_group_summary table. Only used for
 *   purchase/sales voucher types (the ones with itemized inventory lines).
 */
export function normalizeVoucherRow(row, companyInfo, hsnMap = {}) {
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
    const bankLine = findBankOrCashLine(row.ledger_entries);
    const bankLedgerName = bankLine?.name || row.parent_group || "";
    let parties = parsePartyLines(row.ledger_entries, bankLedgerName);

    if (parties.length === 0) {
      parties = [{ partyName: row.party_ledger_name || "", amount: toNumber(row.debit_amount) || toNumber(row.credit_amount) }];
    }

    const amount = parties.reduce((sum, p) => sum + p.amount, 0) || bankLine?.amount || 0;
    const closingBalance = toNumber(row.balance);
    // Payment reduces the ledger balance, Receipt increases it, so the
    // opening balance is derived the opposite way for each. Adjust if your
    // `balance` column means something other than "closing balance after
    // this transaction".
    const openingBalance =
      templateKey === "payment" ? closingBalance + amount : closingBalance - amount;

    return {
      ...base,
      bankAccount: bankLedgerName,
      parties,
      amount,
      openingBalance,
      closingBalance,
    };
  }

  if (templateKey === "purchase" || templateKey === "sales") {
    let items = parseItemLines(row.ledger_entries, hsnMap);
    const { cgst, sgst, igst } = extractTaxTotals(row.ledger_entries);
    const additionalCharges = extractAdditionalCharges(row.ledger_entries, row.party_ledger_name);

    if (items.length === 0) {
      // Fallback: no itemized lines available, show one summary line.
      // HSN still comes from hsnMap if the narration/party happens to match
      // a known stock item name; otherwise blank.
      const fallbackName = row.narration || row.party_ledger_name || "Item";
      items = [
        {
          stockItemName: fallbackName,
          hsnSac: hsnMap[fallbackName] || "",
          quantity: "",
          rate: 0,
          unit: "",
          amount: toNumber(row.debit_amount) || toNumber(row.credit_amount),
        },
      ];
    }

    const itemsTotal = items.reduce((sum, i) => sum + i.amount, 0);
    const chargesTotal = additionalCharges.reduce((sum, c) => sum + c.amount, 0);
    const total = itemsTotal + chargesTotal;

    const firstEntry = Array.isArray(row.ledger_entries) ? row.ledger_entries[0] : undefined;

    return {
      ...base,
      supplierInvoiceNo: pick(firstEntry, ["supplier_invoice_no", "reference"], ""),
      buyerOrderNo: pick(firstEntry, ["buyer_order_no"], ""),
      supplierOrBuyerName: row.party_ledger_name || "",
      supplierOrBuyerAddress: pick(firstEntry, ["address"], ""),
      gstin: pick(firstEntry, ["gstin", "party_gstin"], ""),
      placeOfSupply: pick(firstEntry, ["place_of_supply"], companyInfo.state),
      items,
      additionalCharges,
      total,
      cgst,
      sgst,
      igst,
    };
  }

  return { ...base, raw: row };
}