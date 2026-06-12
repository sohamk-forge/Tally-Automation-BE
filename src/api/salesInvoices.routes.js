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

    console.log("");
    console.log("====================================");
    console.log("SALES INVOICE API HIT");
    console.log("====================================");

    const cleanInvoiceData = JSON.parse(JSON.stringify(invoice_data));

    if (narration) {
      cleanInvoiceData.narration = narration;
    }

    // ✅ No flipping — store everything as-is from frontend
    // Python handles all sign logic internally

    const result = await pool.query(
      `
      INSERT INTO
      app_test.sales_invoice_extractions
      (
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
        $1, $2, $3, $4, $5, $6, $7, 'pending', 0, NULL, NOW(), NOW()
      )
      RETURNING id
      `,
      [
        company.trim(),
        invoice_data.customer_name || "",
        invoice_data.gstin         || "",
        invoice_data.invoice_no    || "",
        invoice_data.invoice_date  || "",
        invoice_data.godown_name   || null,
        cleanInvoiceData
      ]
    );

    const invoiceId = result.rows[0].id;

    await salesQueue.add(
      "sales-invoice",
      { salesId: invoiceId },
      { jobId: getSalesJobId(invoiceId) }
    );

    console.log(`✅ Sales Invoice Queued : ${invoiceId}`);

    return res.status(200).json({
      status:       "success",
      message:      "Sales invoice queued successfully",
      invoice_id:   invoiceId,
      sync_status:  "pending"
    });

  } catch (err) {

    console.log("");
    console.log("====================================");
    console.log("💥 SALES INVOICE API ERROR");
    console.log("====================================");
    console.log(err);

    return res.status(500).json({
      status:  "error",
      message: err.message
    });

  }

});

export default router;