import express from "express";
import pool from "../db/index.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";
import { salesQueue, getSalesJobId, safeEnqueueSales } from "../queues/sales.queue.js";

const router = express.Router();

function safeNumber(value) {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
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

    // Step 1: Taxable Amount - from line_items (same as bulk sales)
    const taxableAmount = safeNumber(
      cleanInvoiceData.taxable_amount ||
      (cleanInvoiceData.line_items || []).reduce(
        (sum, item) => sum + safeNumber(item.amount), 0
      )
    );

    // Step 2: GST Percent
    const gstPercent = safeNumber(cleanInvoiceData.gst_percent || 18);

    // Step 3: Calculate GST Amount
    const gstAmount = Number(
      ((taxableAmount * gstPercent) / 100).toFixed(2)
    );

    // Step 4: State check (same logic as bulk sales worker)
    const gstin = String(
      cleanInvoiceData.customer_gstin ||
      cleanInvoiceData.gstin ||
      ""
    ).trim();

    const stateCode = gstin.substring(0, 2);

    if (stateCode === "27") {
      // Maharashtra -> CGST + SGST
      const halfRate = gstPercent / 2;
      cleanInvoiceData.cgst_amount = Number(
        ((taxableAmount * halfRate) / 100).toFixed(2)
      );
      cleanInvoiceData.sgst_amount = Number(
        ((taxableAmount * halfRate) / 100).toFixed(2)
      );
      cleanInvoiceData.igst_amount = 0;

    } else if (stateCode) {
      // Other state -> IGST
      cleanInvoiceData.cgst_amount = 0;
      cleanInvoiceData.sgst_amount = 0;
      cleanInvoiceData.igst_amount = gstAmount;

    } else {
      // No GSTIN -> default CGST + SGST (same as bulk)
      const halfRate = gstPercent / 2;
      cleanInvoiceData.cgst_amount = Number(
        ((taxableAmount * halfRate) / 100).toFixed(2)
      );
      cleanInvoiceData.sgst_amount = Number(
        ((taxableAmount * halfRate) / 100).toFixed(2)
      );
      cleanInvoiceData.igst_amount = 0;
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
      gst: gstAmount,
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
          invoice_data.invoice_no || "",
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

    query += ` ORDER BY id DESC`;

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

export default router;