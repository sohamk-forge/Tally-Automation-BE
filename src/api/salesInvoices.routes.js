// =========================================
// src/api/salesInvoices.routes.js
// =========================================

import express from "express";
import pool from "../db/index.js";
import {
  salesQueue,
  getSalesJobId
} from "../queues/sales.queue.js";

const router = express.Router();

router.post("/sales-invoices", async (req, res) => {

console.log("BODY RECEIVED:");
console.log(JSON.stringify(req.body, null, 2));

try {

 const {
  company,
  invoice_data,
  narration
} = req.body;

if (!company || !invoice_data) {
  return res.status(400).json({
    status: "error",
    message: "company and invoice_data required"
  });
}

// ✅ Log only after validation
console.log("Sales Ledger From Frontend:", invoice_data.sales_ledger);

    console.log("");
    console.log("====================================");
    console.log("SALES INVOICE API HIT");
    console.log("====================================");

    // ✅ LOOKUP company_id from company_name
    const companyResult = await pool.query(
      `SELECT id FROM app_test.companies WHERE TRIM(name) = TRIM($1)`,
      [company]
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

// ✅ ADD THIS BLOCK HERE
// Recalculate GST only if GST values are not already present
// Step 1: Taxable Amount (from frontend)
const taxableAmount = Number(cleanInvoiceData.taxable_amount || 0);

// Step 2: Calculate GST yourself — never trust frontend's grand_total
const gstPercent = Number(cleanInvoiceData.gst_percent || 18);
const gstAmount = Number(((taxableAmount * gstPercent) / 100).toFixed(2));

// Step 3: State check
const gstin =
  cleanInvoiceData.customer_gstin ||
  cleanInvoiceData.gstin ||
  "";

const stateCode = String(gstin || "").trim().substring(0, 2);

if (stateCode === "27" || !stateCode) {
  // Maharashtra OR no GSTIN → local state
  cleanInvoiceData.cgst_amount = Number((gstAmount / 2).toFixed(2));
  cleanInvoiceData.sgst_amount = Number(
    (gstAmount - cleanInvoiceData.cgst_amount).toFixed(2)
  );
  cleanInvoiceData.igst_amount = 0;
} else {
  cleanInvoiceData.cgst_amount = 0;
  cleanInvoiceData.sgst_amount = 0;
  cleanInvoiceData.igst_amount = gstAmount;
}

// Step 4: Subtract TDS
const tdsAmount = Math.abs(Number(cleanInvoiceData.tds_amount || 0));
cleanInvoiceData.tds_amount = tdsAmount;

// Step 5: Grand Total — calculated, not trusted from frontend
cleanInvoiceData.grand_total = Number((
  taxableAmount +
  cleanInvoiceData.cgst_amount +
  cleanInvoiceData.sgst_amount +
  cleanInvoiceData.igst_amount -
  tdsAmount
).toFixed(2));

console.log("GST CALCULATION:", {
  taxable: taxableAmount,
  gst_percent: gstPercent,
  gst: gstAmount,
  cgst: cleanInvoiceData.cgst_amount,
  sgst: cleanInvoiceData.sgst_amount,
  igst: cleanInvoiceData.igst_amount,
  tds: tdsAmount,
  grand_total: cleanInvoiceData.grand_total
});

    // Check if invoice already exists for this company
    const existingInvoice = await pool.query(
      `
      SELECT id
      FROM app_test.sales_invoice_extractions
      WHERE company_id = $1
        AND LOWER(TRIM(invoice_no)) = LOWER(TRIM($2))
      LIMIT 1
      `,
      [
        companyId,
        (invoice_data.invoice_no || "").trim()
      ]
    );

    let invoiceId;

    if (existingInvoice.rows.length > 0) {

      console.log(`Updating existing invoice: ${invoice_data.invoice_no}`);

      const updateResult = await pool.query(
        `
      UPDATE app_test.sales_invoice_extractions
SET
  customer_name = $1,
  gstin = $2,
  invoice_date = $3,
  godown_name = $4,
  raw_json = $5,
  sync_status = 'pending',
  error_count = 0,
  last_error = NULL,
  error_message = NULL,
  gst_details = NULL,
  updated_at = NOW()
WHERE id = $6
        RETURNING id
        `,
        [
          invoice_data.customer_name || "",
          invoice_data.gstin || "",
          invoice_data.invoice_date || "",
          invoice_data.godown_name ?? "Main Location",
          cleanInvoiceData,
          existingInvoice.rows[0].id
        ]
      );

      invoiceId = updateResult.rows[0].id;
      console.log(`✅ Invoice updated: ${invoiceId}`);

    } else {

      console.log(`Creating new invoice: ${invoice_data.invoice_no}`);

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
          created_at,
          updated_at
        )
        VALUES
        (
          $1, $2, $3, $4, $5, $6, $7, $8, 'pending', 0, NULL, NOW(), NOW()
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

          cleanInvoiceData
        ]
      );

      invoiceId = result.rows[0].id;
      console.log(`✅ New invoice created: ${invoiceId}`);
    }

// ✅ Remove old job first so re-sent invoices always run fresh
const jobId = getSalesJobId(invoiceId);
const existingJob = await salesQueue.getJob(jobId);
if (existingJob) {
  await existingJob.remove();
  console.log(`Old job removed: ${jobId}`);
}

const job = await salesQueue.add(
  "sales-invoice",
  {
  salesId: invoiceId
  
},
  { jobId: jobId }
);

console.log("Job ID:", job.id);
console.log("Job Name:", job.name);
console.log(`✅ Sales Invoice Queued: ${invoiceId}`);

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
    console.log("💥 SALES INVOICE API ERROR");
    console.log("====================================");
    console.log(err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });

  }

});

// ✅ GET API FOR SALES INVOICES
router.get("/sales-invoices", async (req, res) => {
  try {
    const { company_id, sync_status, invoice_no, error_only } = req.query;

    if (!company_id) {
      return res.status(400).json({
        status: "error",
        message: "company_id query parameter required"
      });
    }

    let query = `
      SELECT *
      FROM app_test.sales_invoice_extractions
      WHERE company_id = $1
    `;
    const params = [company_id];

    if (sync_status) {
      query += ` AND sync_status = $${params.length + 1}`;
      params.push(sync_status);
    }

    if (invoice_no) {
      query += ` AND LOWER(TRIM(invoice_no)) = LOWER(TRIM($${params.length + 1}))`;
      params.push(invoice_no);
    }

    if (error_only === 'true') {
      query += ` AND error_count > 0`;
    }

    query += ` ORDER BY id DESC`;

    const result = await pool.query(query, params);

    return res.status(200).json({
      status: "success",
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;