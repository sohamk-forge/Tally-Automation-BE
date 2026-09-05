import express from "express";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";

const router = express.Router();

/* =========================================
   INVOICE / STOCK ITEM CALCULATION API

   POST /api/invoice/calculate

   Given a company + a list of stock items (name, quantity, rate) the
   frontend picked, and optionally the customer's GSTIN/name/state,
   this computes taxable amount, CGST/SGST (intra-state) or IGST
   (inter-state), item-wise totals and invoice-level totals.

   Stock item GST rate/HSN is read from app_test.stock_group_summary
   (the same table src/api/stockGroupSummary.js reads from — it's the
   canonical, Tally-synced source of item GST info in this project).
   The frontend sends only quantity, rate and (optionally) discount; it
   never computes tax itself.

   Body:
   {
     "company_id": 1,                    // preferred (or "company": "name")
     "customer_name": "ABC Traders",     // optional — used to look up
                                          // the customer's state from
                                          // all_ledger_details when no
                                          // gstin/state is supplied
     "customer_gstin": "27ABCDE1234F1Z5",// optional, preferred state source
     "customer_state": "Maharashtra",    // optional fallback state source
     "items": [
       { "item_name": "Item A", "quantity": 10, "rate": 250 },
       { "item_name": "Item B", "quantity": 5,  "rate": 1200, "discount": 10 }
     ]
   }
   discount is a per-line percentage (0-100, default 0), applied before
   computing taxable_amount: quantity * rate * (1 - discount/100).
========================================= */

function round2(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

// Collapses internal whitespace runs to a single space on top of trim+
// lowercase, so an item name that differs from the Tally-synced one only
// by spacing (bulk-upload sheets are a common source of this) still
// matches instead of coming back as "not found" with a 0% GST rate.
function normalizeItemName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function safeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

// Same "Maharashtra by name/abbreviation/code" fallback used in
// salesInvoices.routes.js / bulkSalesV2.worker.js, kept identical here
// so a missing-GSTIN customer resolves to the same intra/inter-state
// answer everywhere in the app.
function isMaharashtraState(value) {
  const state = String(value || "").trim().toLowerCase();
  return state === "maharashtra" || state === "mh" || state === "27" || state.includes("maharashtra");
}

// Same state-code table as salesInvoices.routes.js's GST_STATE_CODES,
// inverted so a free-text state name (e.g. from all_ledger_details.state,
// which stores names, not codes) can resolve to a 2-digit GST code — not
// just Maharashtra. Without this, any non-Maharashtra ledger state would
// silently fall through to "unknown" and default to intra-state (wrong:
// it would charge CGST+SGST instead of IGST for a genuine out-of-state
// customer whose name we can't otherwise map).
const GST_STATE_CODES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab",
  "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana",
  "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh",
  "13": "Nagaland", "14": "Manipur", "15": "Mizoram",
  "16": "Tripura", "17": "Meghalaya", "18": "Assam",
  "19": "West Bengal", "20": "Jharkhand", "21": "Odisha",
  "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra", "28": "Andhra Pradesh", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu",
  "34": "Puducherry", "35": "Andaman and Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh"
};

const STATE_NAME_TO_CODE = Object.entries(GST_STATE_CODES).reduce((acc, [code, name]) => {
  acc[name.trim().toLowerCase()] = code;
  return acc;
}, {});

// Resolves a free-text state value (name OR a bare 2-digit code) to a
// GST state code, or null if it can't be matched.
function resolveStateCode(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^[0-9]{2}$/.test(raw)) return raw;
  return STATE_NAME_TO_CODE[raw.toLowerCase()] || null;
}

router.post("/invoice/calculate", async (req, res) => {
  try {
    const body = req.body || {};

    /* ---------------------------------------
       Resolve company_id -> company_name
       (same dual company_id/company_name support as
       /api/stock/group-summary)
    --------------------------------------- */
    const companyIdParam = body.company_id;
    const companyNameParam = (body.company || "").toString().trim();

    let companyId = null;
    let companyName = null;

    if (companyIdParam !== undefined && companyIdParam !== null && companyIdParam !== "") {
      companyId = Number(companyIdParam);
      if (!Number.isInteger(companyId) || companyId <= 0) {
        return res.status(400).json({ status: "error", message: "company_id must be a positive integer" });
      }

      const companyRow = await pool.query(
        `SELECT id, name FROM ${DB_SCHEMA}.companies WHERE id = $1`,
        [companyId]
      );
      if (!companyRow.rows.length) {
        return res.status(404).json({ status: "error", message: `Company id ${companyId} not found` });
      }
      companyName = (companyRow.rows[0].name || "").trim();
    } else if (companyNameParam) {
      const companyRow = await pool.query(
        `SELECT id, name FROM ${DB_SCHEMA}.companies WHERE lower(trim(name)) = lower(trim($1)) LIMIT 1`,
        [companyNameParam]
      );
      if (!companyRow.rows.length) {
        return res.status(404).json({ status: "error", message: `Company '${companyNameParam}' not found` });
      }
      companyId = companyRow.rows[0].id;
      companyName = (companyRow.rows[0].name || "").trim();
    } else {
      return res.status(400).json({ status: "error", message: "company_id or company required" });
    }

    /* ---------------------------------------
       Validate items
    --------------------------------------- */
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) {
      return res.status(400).json({ status: "error", message: "items array required and must not be empty" });
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || !String(item.item_name || "").trim()) {
        return res.status(400).json({ status: "error", message: `items[${i}].item_name is required` });
      }
      const qty = Number(item.quantity);
      const rate = Number(item.rate);
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ status: "error", message: `items[${i}].quantity must be a positive number` });
      }
      if (!Number.isFinite(rate) || rate < 0) {
        return res.status(400).json({ status: "error", message: `items[${i}].rate must be a non-negative number` });
      }
      if (item.discount !== undefined) {
        const discount = Number(item.discount);
        if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
          return res.status(400).json({ status: "error", message: `items[${i}].discount must be between 0 and 100` });
        }
      }
    }

    /* ---------------------------------------
       Determine company's own state (company_details.gstin/state)
       Same source + "27" fallback as stockGroupSummary.js.
    --------------------------------------- */
    const companyDetailsResult = await pool.query(
      `SELECT gstin, state FROM ${DB_SCHEMA}.company_details WHERE trim(company_name) = trim($1) LIMIT 1`,
      [companyName]
    );

    let companyGSTIN = null;
    let companyStateCode = null;

    if (companyDetailsResult.rows.length) {
      companyGSTIN = companyDetailsResult.rows[0].gstin || null;
      if (companyGSTIN && /^[0-9]{2}/.test(companyGSTIN)) {
        companyStateCode = companyGSTIN.substring(0, 2);
      }
    }
    if (!companyStateCode) {
      companyStateCode = "27"; // last-resort fallback, matches stockGroupSummary.js
    }

    /* ---------------------------------------
       Determine customer's state.
       Priority: gstin prefix > customer_state body field >
       all_ledger_details.state (by customer_name) > unknown.
       Mirrors salesInvoices.routes.js's precedence, adapted for a
       stateless calc call where the customer may not be a saved ledger.
    --------------------------------------- */
    const customerGstin = String(body.customer_gstin || body.gstin || "").trim();
    const customerNameParam = String(body.customer_name || "").trim();
    let customerStateCode = null;
    let stateSource = "unknown";

    if (customerGstin && /^[0-9]{2}/.test(customerGstin)) {
      customerStateCode = customerGstin.substring(0, 2);
      stateSource = "customer_gstin";
    } else if (body.customer_state_code && /^[0-9]{2}$/.test(String(body.customer_state_code).trim())) {
      customerStateCode = String(body.customer_state_code).trim();
      stateSource = "customer_state_code";
    } else if (customerNameParam) {
      const ledgerResult = await pool.query(
        `
        SELECT state
        FROM ${DB_SCHEMA}.all_ledger_details
        WHERE company_id = $1
          AND lower(trim(ledger_name)) = lower(trim($2))
        LIMIT 1
        `,
        [companyId, customerNameParam]
      );
      const ledgerState = ledgerResult.rows[0]?.state;
      const resolved = resolveStateCode(ledgerState);
      if (resolved) {
        customerStateCode = resolved;
        stateSource = "ledger_state";
      }
    }

    if (!customerStateCode && body.customer_state) {
      const resolved = resolveStateCode(body.customer_state) || (isMaharashtraState(body.customer_state) ? "27" : null);
      if (resolved) {
        customerStateCode = resolved;
        stateSource = "customer_state";
      }
    }

    // No usable customer state at all -> default to intra-state, same
    // fallback used in stockGroupSummary.js and salesInvoices.routes.js
    // (an unregistered/unknown customer isn't assumed to be out-of-state).
    const isIntrastate = customerStateCode === null ? true : customerStateCode === companyStateCode;

    if (customerStateCode === null && stateSource === "unknown") {
      stateSource = "no_customer_state_provided";
    }

    /* ---------------------------------------
       Look up GST rate/HSN/unit for every requested item from
       stock_group_summary (one query, most recent row per item_name).
    --------------------------------------- */
    const stockRowsResult = await pool.query(
      `
      SELECT DISTINCT ON (lower(trim(item_name)))
        item_name, hsn_code, unit, gst_rate, cgst_rate, sgst_rate, igst_rate
      FROM ${DB_SCHEMA}.stock_group_summary
      WHERE company_id = $1
      ORDER BY lower(trim(item_name)), id DESC
      `,
      [companyId]
    );

    const stockByName = new Map();
    for (const row of stockRowsResult.rows) {
      stockByName.set(normalizeItemName(row.item_name), row);
    }

    /* ---------------------------------------
       Per-item calculation.
       GST rounded per component, per line item (Number(x.toFixed(2))),
       then summed for invoice totals — the rounding order the
       sales-invoice rounding-fix commits (66a20ba, f7e7429) established
       as correct for this app; rounding only at the aggregate level can
       land a paisa off.
    --------------------------------------- */
    const warnings = [];
    const calculatedItems = items.map((item, index) => {
      const itemName = String(item.item_name).trim();
      const quantity = Number(item.quantity);
      const rate = Number(item.rate);
      const discount = Number(item.discount) || 0;
      const taxableAmount = round2(quantity * rate * (1 - discount / 100));

      const dbRow = stockByName.get(normalizeItemName(itemName));
      const found = Boolean(dbRow);

      if (!found) {
        warnings.push(`items[${index}] "${itemName}": not found in stock_group_summary for this company — GST rate defaulted to 0%`);
      }

      const storedCgstRate = safeNumber(dbRow?.cgst_rate);
      const storedSgstRate = safeNumber(dbRow?.sgst_rate);
      const storedIgstRate = safeNumber(dbRow?.igst_rate);
      const hasStoredRates = storedCgstRate > 0 || storedSgstRate > 0 || storedIgstRate > 0;

      let cgstRate = 0, sgstRate = 0, igstRate = 0, rateSource;

      if (hasStoredRates) {
        cgstRate = storedCgstRate;
        sgstRate = storedSgstRate;
        igstRate = storedIgstRate;
        rateSource = "tally_item_rate";
      } else {
        const gstRate = safeNumber(dbRow?.gst_rate);
        if (isIntrastate) {
          cgstRate = gstRate / 2;
          sgstRate = gstRate / 2;
        } else {
          igstRate = gstRate;
        }
        rateSource = found ? "state_split_fallback" : "item_not_found";
      }

      const cgstAmount = round2((taxableAmount * cgstRate) / 100);
      const sgstAmount = round2((taxableAmount * sgstRate) / 100);
      const igstAmount = round2((taxableAmount * igstRate) / 100);
      const totalGstAmount = round2(cgstAmount + sgstAmount + igstAmount);
      const itemTotal = round2(taxableAmount + totalGstAmount);

      return {
        item_name: itemName,
        hsn_code: dbRow?.hsn_code || null,
        unit: dbRow?.unit || null,
        quantity,
        rate,
        discount,
        taxable_amount: taxableAmount,
        gst_rate: safeNumber(dbRow?.gst_rate),
        cgst_rate: cgstRate,
        sgst_rate: sgstRate,
        igst_rate: igstRate,
        cgst_amount: cgstAmount,
        sgst_amount: sgstAmount,
        igst_amount: igstAmount,
        total_gst_amount: totalGstAmount,
        item_total: itemTotal,
        rate_source: rateSource,
        found
      };
    });

    /* ---------------------------------------
       Invoice-level totals — sum of the already-rounded item figures.
    --------------------------------------- */
    const invoiceSummary = calculatedItems.reduce(
      (acc, item) => {
        acc.total_taxable_amount = round2(acc.total_taxable_amount + item.taxable_amount);
        acc.total_cgst_amount = round2(acc.total_cgst_amount + item.cgst_amount);
        acc.total_sgst_amount = round2(acc.total_sgst_amount + item.sgst_amount);
        acc.total_igst_amount = round2(acc.total_igst_amount + item.igst_amount);
        acc.total_gst_amount = round2(acc.total_gst_amount + item.total_gst_amount);
        acc.grand_total = round2(acc.grand_total + item.item_total);
        return acc;
      },
      {
        total_taxable_amount: 0,
        total_cgst_amount: 0,
        total_sgst_amount: 0,
        total_igst_amount: 0,
        total_gst_amount: 0,
        grand_total: 0
      }
    );
    invoiceSummary.total_items = calculatedItems.length;

    return res.status(200).json({
      status: "success",
      company_id: companyId,
      company_name: companyName,
      company_gstin: companyGSTIN,
      company_state_code: companyStateCode,
      customer_state_code: customerStateCode,
      state_source: stateSource,
      is_intrastate: isIntrastate,
      tax_type: isIntrastate ? "CGST_SGST" : "IGST",
      items: calculatedItems,
      invoice_summary: invoiceSummary,
      warnings
    });

  } catch (err) {
    console.log("❌ INVOICE CALCULATION API ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;
