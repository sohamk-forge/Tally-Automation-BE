import express from "express";
import pool from "../db/index.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";
import { salesQueue, getSalesJobId, safeEnqueueSales } from "../queues/sales.queue.js";
import { markChallansInvoiced } from "../services/challan.service.js";
import { findTopItemMatches } from "../utils/fuzzyItemMatch.js";

const router = express.Router();

function safeNumber(value) {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

// Free-text state name match against the COMPANY's own state (fetched
// dynamically from company_details — see companyStateCode/companyStateName
// below), used as a fallback only when there's no GSTIN to derive the
// customer's state code from. Previously this hardcoded "Maharashtra" as
// if every company using this app were based there; it's now compared
// against whichever company is actually making the call.
function isSameStateAsCompany(customerState, companyStateName) {
  const c = String(customerState || "").trim().toLowerCase();
  const co = String(companyStateName || "").trim().toLowerCase();
  if (!c || !co) return false;
  return c === co || c.includes(co) || co.includes(c);
}

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

function getCustomerState(customerState, gstin) {
  if (customerState && customerState.trim()) {
    return customerState.trim();
  }
  if (gstin && gstin.length >= 2) {
    return GST_STATE_CODES[gstin.substring(0, 2)] || "";
  }
  return "";
}

function getGstRegistrationType(gstin) {
  return gstin && gstin.trim() ? "Regular" : "Unregistered/Consumer";
}

router.post("/sales-invoices", async (req, res) => {

  console.log("BODY RECEIVED:");
  console.log(JSON.stringify(req.body, null, 2));

  try {

    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "Unauthenticated"
      });
    }

    const {
      company,
      invoice_data,
      narration,
      // Optional. If the caller (e.g. the Review tab's retry) knows which row it
      // is re-pushing, it can send the id and we update that exact row.
      invoice_id
    } = req.body;

    if (!company || !invoice_data) {
      return res.status(400).json({
        status: "error",
        message: "company and invoice_data required"
      });
    }

    console.log("Sales Ledger From Frontend:", invoice_data.sales_ledger);

    console.log("");
    console.log("====================================");
    console.log("SALES INVOICE API HIT");
    console.log("====================================");

    // Scoped to this acting user's own pairing, not a bare global name
    // match — two unrelated companies can share a name, and a global
    // lookup here would silently resolve to whichever row Postgres
    // happens to return, possibly someone else's company. This also
    // doubles as the ownership check (a company this user has no access
    // to simply won't match), replacing the disabled checkCompanyAccess
    // call that used to check the vestigial user_companies table.
    const companyResult = await pool.query(
      `
      SELECT c.id
      FROM app_test.companies c
      JOIN app_test.connector_pairing_tokens cpt ON cpt.company_id = c.id
      WHERE cpt.user_id = $1
        AND cpt.is_used = TRUE
        AND lower(trim(c.name)) = lower(trim($2))
      LIMIT 1
      `,
      [userId, company]
    );

    const companyId = companyResult.rows[0]?.id;

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: `Company '${company}' not found`
      });
    }

    const cleanInvoiceData = JSON.parse(JSON.stringify(invoice_data));

    if (narration) {
      cleanInvoiceData.narration = narration;
    }

    // =========================================
    // GST CALCULATION - SAME AS BULK SALES WORKER
    // =========================================

    const lineItems = cleanInvoiceData.line_items || [];

    // Step 1: Taxable Amount - from line_items (same as bulk sales)
    const taxableAmount = safeNumber(
      cleanInvoiceData.taxable_amount ||
      lineItems.reduce((sum, item) => sum + safeNumber(item.amount), 0)
    );

    // Step 2: GST Percent - fallback used only for line items that don't
    // carry their own rate.
    const gstPercent = safeNumber(cleanInvoiceData.gst_percent || 18);

    // Step 3: State check
    const gstin = String(
      cleanInvoiceData.customer_gstin ||
      cleanInvoiceData.gstin ||
      ""
    ).trim();

    const stateCode = gstin.substring(0, 2);

    // Company's own state — dynamically from company_details (synced from
    // Tally's Company GST Details), same pattern already used in
    // invoiceCalculation.routes.js / stockGroupSummary.js. Only falls back
    // to "27" (Maharashtra) as a last resort if no company_details row
    // exists yet — this used to be hardcoded unconditionally, which was
    // wrong for any company not based in Maharashtra.
    const companyDetailsResult = await pool.query(
      `SELECT gstin, state FROM app_test.company_details WHERE trim(company_name) = trim($1) LIMIT 1`,
      [company]
    );
    let companyStateCode = null;
    let companyStateName = "";
    if (companyDetailsResult.rows.length) {
      const companyGSTIN = companyDetailsResult.rows[0].gstin || null;
      if (companyGSTIN && /^[0-9]{2}/.test(companyGSTIN)) {
        companyStateCode = companyGSTIN.substring(0, 2);
      }
      companyStateName = companyDetailsResult.rows[0].state || "";
    }
    if (!companyStateCode) {
      companyStateCode = "27";
    }

    // No GSTIN — fall back to the customer's bill-to state rather than
    // assuming intrastate. An unregistered customer outside Maharashtra is
    // still interstate (IGST); only default to CGST+SGST when nothing else
    // says otherwise. Primary source is the customer's own synced ledger
    // (all_ledger_details.state, from Tally) looked up by name — the
    // frontend doesn't send a state field on this form, so a body-supplied
    // customer_state/bill_to_state is kept only as a secondary fallback for
    // a customer with no synced ledger yet.
    let customerState = "";

    if (!stateCode && cleanInvoiceData.customer_name) {
      const ledgerResult = await pool.query(
        `
        SELECT state
        FROM app_test.all_ledger_details
        WHERE company_id = $1
          AND LOWER(TRIM(ledger_name)) = LOWER(TRIM($2))
        LIMIT 1
        `,
        [companyId, cleanInvoiceData.customer_name]
      );
      customerState = String(ledgerResult.rows[0]?.state || "").trim();
    }

    if (!customerState) {
      customerState = String(
        cleanInvoiceData.customer_state ||
        cleanInvoiceData.bill_to_state ||
        ""
      ).trim();
    }

    const isIntrastate = stateCode
      ? stateCode === companyStateCode
      : isSameStateAsCompany(customerState, companyStateName) || !customerState;

    // Step 4: GST amount - trust the value the frontend already computed
    // and sent (cgst_amount/sgst_amount/igst_amount on invoice_data). The
    // frontend prefers the Excel/OCR-sourced tax figure when one exists
    // (taxOverride, from raw_json), falling back to its own per-line-item
    // recompute otherwise — that's the number the user actually saw and
    // approved on screen. Recomputing independently here, even per line
    // item, can still land a paisa off the source invoice (rounding order/
    // precision doesn't always agree between two independent code paths),
    // so recompute is kept only as a fallback for callers that don't send
    // an amount at all.
    const halfRate = gstPercent / 2;
    const sentCgst = cleanInvoiceData.cgst_amount;
    const sentSgst = cleanInvoiceData.sgst_amount;
    const sentIgst = cleanInvoiceData.igst_amount;

    const perLineTax = (rateField, fallbackRate) => {
      let total = 0;
      for (const item of lineItems) {
        const amt = safeNumber(item.amount);
        const rate = item[rateField] != null ? safeNumber(item[rateField]) : fallbackRate;
        total += Number(((amt * rate) / 100).toFixed(2));
      }
      return Number(total.toFixed(2));
    };

    if (isIntrastate) {
      // Maharashtra (or unknown) -> CGST + SGST
      cleanInvoiceData.cgst_amount = sentCgst !== undefined && sentCgst !== null && sentCgst !== ""
        ? safeNumber(sentCgst)
        : perLineTax("cgst_rate", halfRate);
      cleanInvoiceData.sgst_amount = sentSgst !== undefined && sentSgst !== null && sentSgst !== ""
        ? safeNumber(sentSgst)
        : perLineTax("sgst_rate", halfRate);
      cleanInvoiceData.igst_amount = 0;

    } else {
      // Other state -> IGST
      cleanInvoiceData.cgst_amount = 0;
      cleanInvoiceData.sgst_amount = 0;
      cleanInvoiceData.igst_amount = sentIgst !== undefined && sentIgst !== null && sentIgst !== ""
        ? safeNumber(sentIgst)
        : perLineTax("igst_rate", gstPercent);
    }

    // Step 5: TDS - abs() same as bulk
    const tdsAmount = Math.abs(safeNumber(cleanInvoiceData.tds_amount || 0));
    cleanInvoiceData.tds_amount = tdsAmount;

    // Step 6: Round Off - taken as-is from frontend (same as bulk)
    const roundOff = safeNumber(cleanInvoiceData.round_off || 0);
    cleanInvoiceData.round_off = roundOff;

    // Step 7: Taxable amount stored
    cleanInvoiceData.taxable_amount = taxableAmount;
    cleanInvoiceData.gst_percent = gstPercent;

    // Step 8: Grand Total (same formula as bulk sales worker)
    cleanInvoiceData.grand_total = Number((
      taxableAmount +
      cleanInvoiceData.cgst_amount +
      cleanInvoiceData.sgst_amount +
      cleanInvoiceData.igst_amount -
      tdsAmount +
      roundOff
    ).toFixed(2));

    console.log("GST CALCULATION:", {
      taxable: taxableAmount,
      gst_percent: gstPercent,
      customer_state: customerState || "—",
      is_intrastate: isIntrastate,
      cgst: cleanInvoiceData.cgst_amount,
      sgst: cleanInvoiceData.sgst_amount,
      igst: cleanInvoiceData.igst_amount,
      tds: tdsAmount,
      round_off: roundOff,
      grand_total: cleanInvoiceData.grand_total
    });

    // =========================================
    // FIND THE EXISTING ROW (OR DECIDE IT IS NEW)
    // =========================================
    //
    // invoice_no stays OPTIONAL, so we try three ways in order of reliability:
    //
    //   1. invoice_id sent by the caller  -> exact row, always correct
    //   2. invoice_no supplied            -> match on the number (original behaviour)
    //   3. neither                        -> match on the invoice's own content
    //
    // Case 3 is what fixes the duplicate: a retry that arrives with an empty
    // invoice_no used to match nothing and INSERT a second row, leaving the old
    // failed row in the Review tab while the new row showed success - the same
    // invoice appearing in both tabs (seen with ids 3192 and 4593).
    //
    // Caveat on case 3: two genuinely different invoices for the same customer,
    // on the same date, for the same total, both pushed with no invoice number,
    // would be treated as one. Send invoice_id from the retry to avoid this.

    let existingInvoice;
    let matchedBy;

    if (invoice_id) {

      matchedBy = "invoice_id";
      existingInvoice = await pool.query(
        `
        SELECT id
        FROM app_test.sales_invoice_extractions
        WHERE id = $1
          AND company_id = $2
        LIMIT 1
        `,
        [invoice_id, companyId]
      );

    } else if ((invoice_data.invoice_no || "").trim()) {

      matchedBy = "invoice_no";
      existingInvoice = await pool.query(
        `
        SELECT id
        FROM app_test.sales_invoice_extractions
        WHERE company_id = $1
          AND LOWER(TRIM(invoice_no)) = LOWER(TRIM($2))
        LIMIT 1
        `,
        [companyId, invoice_data.invoice_no.trim()]
      );

    } else {

      matchedBy = "content";
      // ORDER BY id ASC so we land on the ORIGINAL row, not a duplicate that a
      // previous run may already have created.
      existingInvoice = await pool.query(
        `
        SELECT id
        FROM app_test.sales_invoice_extractions
        WHERE company_id = $1
          AND LOWER(TRIM(customer_name)) = LOWER(TRIM($2))
          AND TRIM(invoice_date) = TRIM($3)
          AND (raw_json->>'grand_total')::numeric = $4
        ORDER BY id ASC
        LIMIT 1
        `,
        [
          companyId,
          invoice_data.customer_name || "",
          invoice_data.invoice_date || "",
          cleanInvoiceData.grand_total
        ]
      );

    }

    console.log(
      `Invoice lookup by ${matchedBy}: ${existingInvoice.rows.length ? `matched id ${existingInvoice.rows[0].id}` : "no match (will insert)"}`
    );

    let invoiceId;

    if (existingInvoice.rows.length > 0) {

      console.log(`Updating existing invoice: ${invoice_data.invoice_no || "(no invoice_no)"}`);

      // invoice_no is written here too, so a retry that supplies a corrected
      // number updates it. COALESCE/NULLIF keeps the stored number when the
      // retry sends a blank one, instead of wiping it.
      const updateResult = await pool.query(
        `
        UPDATE app_test.sales_invoice_extractions
        SET
          customer_name = $1,
          gstin = $2,
          invoice_date = $3,
          godown_name = $4,
          raw_json = $5,
          invoice_no = COALESCE(NULLIF(TRIM($6), ''), invoice_no),
          sync_status = 'pending',
          error_count = 0,
          last_error = NULL,
          error_message = NULL,
          gst_details = NULL,
          user_id = $7,
          updated_at = NOW()
        WHERE id = $8
        RETURNING id
        `,
        [
          invoice_data.customer_name || "",
          invoice_data.gstin || "",
          invoice_data.invoice_date || "",
          invoice_data.godown_name ?? "Main Location",
          cleanInvoiceData,
          invoice_data.invoice_no || "",
          userId,
          existingInvoice.rows[0].id
        ]
      );

      invoiceId = updateResult.rows[0].id;
      console.log(`Invoice updated: ${invoiceId}`);

    } else {

      console.log(`Creating new invoice: ${invoice_data.invoice_no || "(no invoice_no)"}`);

      const result = await pool.query(
        `
        INSERT INTO app_test.sales_invoice_extractions
        (
          company_id,
          company_name,
          customer_name,
          gstin,
          invoice_no,
          invoice_date,
          godown_name,
          raw_json,
          sync_status,
          error_count,
          last_error,
          user_id,
          created_at,
          updated_at
        )
        VALUES
        (
          $1, $2, $3, $4, $5, $6, $7, $8, 'pending', 0, NULL, $9, NOW(), NOW()
        )
        RETURNING id
        `,
        [
          companyId,
          company.trim(),
          invoice_data.customer_name || "",
          invoice_data.gstin || "",
          // NULL, not "" — the unique constraint on (company_id, invoice_no)
          // treats "" as a real, colliding value (unlike NULL, which SQL
          // exempts from uniqueness), so a blank invoice_no here would let
          // only the FIRST invoice for a company ever save successfully.
          invoice_data.invoice_no?.trim() || null,
          invoice_data.invoice_date || "",
          invoice_data.godown_name ?? "Main Location",
          cleanInvoiceData,
          userId
        ]
      );

      invoiceId = result.rows[0].id;
      console.log(`New invoice created: ${invoiceId}`);
    }

    const { jobId, action } = await safeEnqueueSales(invoiceId, userId);
    console.log(`Sales Invoice Queued: ${invoiceId} (job ${jobId}, ${action})`);

    // Whatever delivery challans this invoice was billed against should drop
    // out of "Bills to be Made" now that they've been invoiced.
    const deliveryChallanNumbers = (invoice_data.delivery_challans || [])
      .map((dc) => dc?.number)
      .filter(Boolean);

    if (deliveryChallanNumbers.length) {
      try {
        const marked = await markChallansInvoiced(companyId, deliveryChallanNumbers);
        console.log(`Marked ${marked} challan(s) as invoiced:`, deliveryChallanNumbers);
      } catch (markErr) {
        // Non-fatal — the invoice itself already succeeded and is queued.
        console.error("Failed to mark challans as invoiced:", markErr.message);
      }
    }

    return res.status(200).json({
      status: "success",
      message: existingInvoice.rows.length > 0
        ? "Sales invoice updated and queued successfully"
        : "Sales invoice created and queued successfully",
      invoice_id: invoiceId,
      company_id: companyId,
      sync_status: "pending"
    });

  } catch (err) {

    console.log("");
    console.log("====================================");
    console.log("SALES INVOICE API ERROR");
    console.log("====================================");
    console.log(err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });

  }

});

router.get("/sales-invoices", async (req, res) => {
  try {
    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "Unauthenticated"
      });
    }
    const companyId = validateCompanyId(req.query.company_id);
    const { sync_status, invoice_no, error_only } = req.query;

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: "company_id query parameter required"
      });
    }

    // const hasAccess = await checkCompanyAccess(userId, companyId);
    // if (!hasAccess) {
    //   return res.status(403).json({
    //     status: "error",
    //     message: "You don't have access to this company"
    //   });
    // }

    let query = `
      SELECT *
      FROM app_test.sales_invoice_extractions
      WHERE company_id = $1
    `;
    const params = [companyId];

    if (sync_status) {
      query += ` AND sync_status = $${params.length + 1}`;
      params.push(sync_status);
    }

    if (invoice_no) {
      query += ` AND LOWER(TRIM(invoice_no)) = LOWER(TRIM($${params.length + 1}))`;
      params.push(invoice_no);
    }

    // NOTE: nothing in the codebase increments error_count - it is 0 on every
    // row - so this filter currently returns nothing. The Review tab should
    // filter on sync_status = 'failed' instead.
    if (error_only === 'true') {
      query += ` AND error_count > 0`;
    }

    // Most-recently-touched first, not just most-recently-created — an
    // invoice that just succeeded via a Review-tab retry (same row, same
    // id, but freshly re-validated and pushed) should surface at the top
    // of All Invoices immediately, not stay buried wherever its original
    // (much older) id happens to sort.
    query += ` ORDER BY updated_at DESC, id DESC`;

    const result = await pool.query(query, params);

    // Only failed rows get state / gst_registration_type added — everything
    // else passes through unchanged, exactly as the DB returned it.
 const data = result.rows.map((row) => {
  const raw = row.raw_json || {};
  const gstin = row.gstin || raw.customer_gstin || "";

  return {
    ...row,
    state: getCustomerState(raw.customer_state, gstin),
    gst_registration_type: getGstRegistrationType(gstin)
  };
});

    return res.status(200).json({
      status: "success",
      company_id: companyId,
      count: data.length,
      data
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});
router.delete("/sales-invoice-delete", async (req, res) => {
  try {
    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "Unauthenticated"
      });
    }

    const { invoice_ids } = req.body;

    if (!Array.isArray(invoice_ids) || invoice_ids.length === 0) {
      return res.status(400).json({
        status: "error",
        message: "invoice_ids array is required"
      });
    }

    // Validate IDs
    const invalidIds = invoice_ids.filter(id => isNaN(Number(id)));

    if (invalidIds.length > 0) {
      return res.status(400).json({
        status: "error",
        message: "All invoice ids must be valid numbers"
      });
    }

    // Check existing invoices
    const existing = await pool.query(
      `
      SELECT id 
      FROM app_test.sales_invoice_extractions
      WHERE id = ANY($1)
      `,
      [invoice_ids]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "No invoices found"
      });
    }

    // Remove queued jobs
    for (const invoice of existing.rows) {
      const jobId = getSalesJobId(invoice.id);

      const existingJob = await salesQueue.getJob(jobId);

      if (existingJob) {
        await existingJob.remove();
        console.log(`Removed job: ${jobId}`);
      }
    }

    // Bulk delete
    await pool.query(
      `
      DELETE FROM app_test.sales_invoice_extractions
      WHERE id = ANY($1)
      `,
      [invoice_ids]
    );

    console.log(`Deleted invoices: ${invoice_ids.join(", ")}`);

    return res.status(200).json({
      status: "success",
      message: "Invoices deleted successfully",
      deleted_invoice_ids: invoice_ids.map(Number)
    });

  } catch (err) {
    console.error("DELETE invoices error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

/* =========================================
   GET /sales-invoices/missing-summary
   Aggregates distinct missing ledgers/stock items across every failed
   invoice for a company, so the Review tab can list "this ledger is
   blocking 3 invoices" instead of the user finding that out one invoice
   at a time. Reads the structured JSON pushSalesInvoice.worker.js already
   writes into error_message on a validation failure — rows whose
   error_message isn't that shape (a different kind of failure, or a
   historical row from before this format existed) are safely skipped
   rather than guessed at.
========================================= */
router.get("/sales-invoices/missing-summary", async (req, res) => {
  try {
    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthenticated" });
    }

    const companyId = validateCompanyId(req.query.company_id);
    if (!companyId) {
      return res.status(400).json({ status: "error", message: "company_id query parameter required" });
    }

    const result = await pool.query(
      `
      SELECT id, error_message
      FROM app_test.sales_invoice_extractions
      WHERE company_id = $1
        AND sync_status IN ('ledger_missing', 'stock_missing', 'ledger_and_stock_missing', 'failed')
        AND error_message IS NOT NULL
      `,
      [companyId]
    );

    const ledgerMap = new Map();
    const itemMap = new Map();

    const addTo = (map, rawName, invoiceId) => {
      const name = String(rawName || "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (!map.has(key)) {
        map.set(key, { name, count: 0, invoice_ids: [] });
      }
      const entry = map.get(key);
      entry.count += 1;
      entry.invoice_ids.push(invoiceId);
    };

    for (const row of result.rows) {
      let parsed;
      try {
        parsed = JSON.parse(row.error_message);
      } catch {
        continue; // not JSON — a different kind of failure, skip
      }

      for (const l of parsed.missing_ledgers || []) {
        addTo(ledgerMap, l.ledger || l.name || l, row.id);
      }
      for (const itemName of parsed.missing_stock_items || []) {
        addTo(itemMap, itemName, row.id);
      }
    }

    // Fuzzy-match suggestions for each missing item name, against every
    // real stock item name this company actually has (synced from Tally,
    // or already successfully pushed) — so the user can resolve a typo'd
    // or slightly-off name from the upload sheet by mapping it onto a real
    // item that already exists, instead of creating a duplicate. This is
    // suggest-only (much lower threshold than the auto-apply match used
    // during push validation) — nothing here changes any data on its own.
    const missingItemNames = [...itemMap.values()];
    if (missingItemNames.length) {
      const knownNamesResult = await pool.query(
        `
        SELECT item_name FROM app_test.stock_group_summary WHERE company_id = $1
        UNION
        SELECT item_name FROM app_test.push_stock_item WHERE company_id = $1 AND status = 'success'
        `,
        [companyId]
      );
      const knownNames = knownNamesResult.rows.map((r) => r.item_name).filter(Boolean);

      for (const entry of missingItemNames) {
        // Only surface a suggestion the user can trust at a glance — 90%+
        // similarity, same floor as the auto-apply match used during push
        // validation. Below that, a wrong guess is more distracting than
        // helpful, so nothing is shown rather than a shaky suggestion.
        entry.suggestions = findTopItemMatches(knownNames, entry.name, { minScore: 0.9 });
      }
    }

    return res.status(200).json({
      status: "success",
      missing_ledgers: [...ledgerMap.values()].sort((a, b) => b.count - a.count),
      missing_stock_items: missingItemNames.sort((a, b) => b.count - a.count)
    });
  } catch (err) {
    console.error("GET missing-summary error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   POST /sales-invoices/resolve-missing-item
   Renames a missing item name to a real, existing stock item name across
   every affected invoice's own stored line items, then re-queues those
   invoices — the "did you mean X?" fix from the Review tab's Items view.
   Unlike retry-batch (which just re-pushes unchanged data), this actually
   edits raw_json first, since retrying with the same wrong name would only
   fail validation again the same way.
========================================= */
router.post("/sales-invoices/resolve-missing-item", async (req, res) => {
  try {
    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthenticated" });
    }

    const { company, wrong_name, correct_name, invoice_ids } = req.body;

    if (!company) {
      return res.status(400).json({ status: "error", message: "company is required" });
    }
    if (!String(wrong_name || "").trim() || !String(correct_name || "").trim()) {
      return res.status(400).json({ status: "error", message: "wrong_name and correct_name are required" });
    }
    if (!Array.isArray(invoice_ids) || invoice_ids.length === 0) {
      return res.status(400).json({ status: "error", message: "invoice_ids array is required" });
    }

    const companyResult = await pool.query(
      `
      SELECT c.id
      FROM app_test.companies c
      JOIN app_test.connector_pairing_tokens cpt ON cpt.company_id = c.id
      WHERE cpt.user_id = $1
        AND cpt.is_used = TRUE
        AND lower(trim(c.name)) = lower(trim($2))
      LIMIT 1
      `,
      [userId, company]
    );

    const companyId = companyResult.rows[0]?.id;
    if (!companyId) {
      return res.status(400).json({ status: "error", message: `Company '${company}' not found` });
    }

    const existing = await pool.query(
      `
      SELECT id, raw_json
      FROM app_test.sales_invoice_extractions
      WHERE id = ANY($1) AND company_id = $2
      `,
      [invoice_ids, companyId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "No matching invoices found for this company" });
    }

    const wrongNameLower = String(wrong_name).trim().toLowerCase();
    const results = [];

    for (const row of existing.rows) {
      try {
        const rawJson = typeof row.raw_json === "string" ? JSON.parse(row.raw_json) : row.raw_json;
        const lineItems = Array.isArray(rawJson?.line_items) ? rawJson.line_items : [];

        let renamed = 0;
        for (const item of lineItems) {
          if (String(item.item_name || "").trim().toLowerCase() === wrongNameLower) {
            item.item_name = correct_name;
            renamed++;
          }
        }

        if (renamed === 0) {
          results.push({ id: row.id, status: "skipped", message: "item name not found on this invoice" });
          continue;
        }

        await pool.query(
          `
          UPDATE app_test.sales_invoice_extractions
          SET raw_json = $1, sync_status = 'pending', error_count = 0, error_message = NULL, updated_at = NOW()
          WHERE id = $2
          `,
          [rawJson, row.id]
        );
        await safeEnqueueSales(row.id, userId);
        results.push({ id: row.id, status: "queued" });
      } catch (err) {
        console.error(`resolve-missing-item: failed for invoice ${row.id}:`, err.message);
        results.push({ id: row.id, status: "error", message: err.message });
      }
    }

    return res.status(200).json({
      status: "success",
      message: `${results.filter((r) => r.status === "queued").length} of ${invoice_ids.length} invoice(s) updated and re-queued`,
      results
    });
  } catch (err) {
    console.error("POST resolve-missing-item error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =========================================
   POST /sales-invoices/retry-batch
   Re-queues a set of previously-failed invoices for another push attempt,
   straight from each row's own already-stored raw_json — used after the
   user creates a missing ledger/stock item from the Review tab and wants
   to clear every invoice that was blocked on it in one action, rather
   than reopening and re-pushing each one individually (the existing
   single-invoice retry on POST /sales-invoices expects a freshly-edited
   invoice_data payload, which is the wrong shape here — nothing about
   these invoices changed except the missing entity now exists).
========================================= */
router.post("/sales-invoices/retry-batch", async (req, res) => {
  try {
    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthenticated" });
    }

    const { company, invoice_ids } = req.body;

    if (!company) {
      return res.status(400).json({ status: "error", message: "company is required" });
    }
    if (!Array.isArray(invoice_ids) || invoice_ids.length === 0) {
      return res.status(400).json({ status: "error", message: "invoice_ids array is required" });
    }
    const invalidIds = invoice_ids.filter((id) => isNaN(Number(id)));
    if (invalidIds.length > 0) {
      return res.status(400).json({ status: "error", message: "All invoice ids must be valid numbers" });
    }

    // Scoped to this acting user's own pairing, same ownership pattern as
    // the single-invoice push route above — a company this user has no
    // access to simply won't match, and the ANY($2) below then can't
    // touch any row belonging to it.
    const companyResult = await pool.query(
      `
      SELECT c.id
      FROM app_test.companies c
      JOIN app_test.connector_pairing_tokens cpt ON cpt.company_id = c.id
      WHERE cpt.user_id = $1
        AND cpt.is_used = TRUE
        AND lower(trim(c.name)) = lower(trim($2))
      LIMIT 1
      `,
      [userId, company]
    );

    const companyId = companyResult.rows[0]?.id;
    if (!companyId) {
      return res.status(400).json({ status: "error", message: `Company '${company}' not found` });
    }

    const existing = await pool.query(
      `
      SELECT id
      FROM app_test.sales_invoice_extractions
      WHERE id = ANY($1) AND company_id = $2
      `,
      [invoice_ids, companyId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "No matching invoices found for this company" });
    }

    const results = [];
    for (const row of existing.rows) {
      try {
        await pool.query(
          `
          UPDATE app_test.sales_invoice_extractions
          SET sync_status = 'pending', error_count = 0, error_message = NULL, updated_at = NOW()
          WHERE id = $1
          `,
          [row.id]
        );
        await safeEnqueueSales(row.id, userId);
        results.push({ id: row.id, status: "queued" });
      } catch (err) {
        console.error(`retry-batch: failed to re-queue invoice ${row.id}:`, err.message);
        results.push({ id: row.id, status: "error", message: err.message });
      }
    }

    return res.status(200).json({
      status: "success",
      message: `${results.filter((r) => r.status === "queued").length} of ${invoice_ids.length} invoice(s) re-queued`,
      results
    });
  } catch (err) {
    console.error("POST retry-batch error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// Resolves a "state_mismatch" invoice (customer's actual Tally ledger state
// disagrees with the state on the invoice/bulk-upload sheet — see
// pushSalesInvoice.worker.js's state-consistency check). The user picks
// which one to trust; that choice only affects THIS invoice's own data
// (its raw_json.customer_state), never the customer's ledger master itself.
router.post("/sales-invoices/:id/resolve-state-mismatch", async (req, res) => {
  try {
    const userId = req.session
      ? await getLocalUserId(req.session.getUserId())
      : req.connectorMachine?.userId;

    if (!userId) {
      return res.status(401).json({ status: "error", message: "Unauthenticated" });
    }

    const { id } = req.params;
    const { chosen } = req.body;

    if (!["ledger", "excel"].includes(chosen)) {
      return res.status(400).json({ status: "error", message: "chosen must be 'ledger' or 'excel'" });
    }

    const invoiceResult = await pool.query(
      `SELECT id, raw_json, error_message, sync_status FROM app_test.sales_invoice_extractions WHERE id = $1`,
      [id]
    );

    const row = invoiceResult.rows[0];
    if (!row) {
      return res.status(404).json({ status: "error", message: "Invoice not found" });
    }
    if (row.sync_status !== "state_mismatch") {
      return res.status(400).json({ status: "error", message: "This invoice has no state mismatch to resolve" });
    }

    let detail;
    try {
      detail = typeof row.error_message === "string" ? JSON.parse(row.error_message) : row.error_message;
    } catch {
      detail = null;
    }

    const chosenState = chosen === "ledger" ? detail?.ledger_state : detail?.invoice_state;
    if (!chosenState) {
      return res.status(400).json({ status: "error", message: "Could not resolve a state from the stored mismatch details" });
    }

    const rawJson = typeof row.raw_json === "string" ? JSON.parse(row.raw_json) : row.raw_json;
    rawJson.customer_state = chosenState;

    // Keeping the invoice's own state means it still disagrees with the
    // ledger (that's the whole point of this choice) — mark it as a
    // deliberate, already-confirmed decision so the worker's state-check
    // doesn't just re-flag the identical mismatch again on this retry.
    // Not needed for "ledger": that overwrites customer_state to equal the
    // ledger's own state, so the comparison naturally passes on its own.
    if (chosen === "excel") {
      rawJson._state_mismatch_acknowledged = true;
    }

    await pool.query(
      `
      UPDATE app_test.sales_invoice_extractions
      SET raw_json = $1, sync_status = 'pending', error_count = 0, error_message = NULL, updated_at = NOW()
      WHERE id = $2
      `,
      [JSON.stringify(rawJson), id]
    );

    await safeEnqueueSales(Number(id), userId);

    return res.status(200).json({
      status: "success",
      message: `Invoice re-queued using the ${chosen === "ledger" ? "ledger's" : "invoice's"} state ("${chosenState}").`
    });
  } catch (err) {
    console.error("POST resolve-state-mismatch error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;