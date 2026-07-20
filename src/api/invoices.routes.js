import express from "express";
import pool from "../db/index.js";
import {
  purchaseQueue,
  getPurchaseJobId
} from "../queues/purchase.queue.js";
import {
  purchaseQueue,
  getPurchaseJobId
} from "../queues/purchase.queue.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

router.post("/invoices", async (req, res) => {
  try {
    const {
      company,
      invoice_data
    } = req.body;

    // ─────────────────────────────────────────────────────────────
    // STEP 1: VALIDATE REQUIRED FIELDS
    // ─────────────────────────────────────────────────────────────

    if (!company?.trim()) {
    // ─────────────────────────────────────────────────────────────
    // STEP 1: VALIDATE REQUIRED FIELDS
    // ─────────────────────────────────────────────────────────────

    if (!company?.trim()) {
      return res.status(400).json({
        error: "Company is required"
        error: "Company is required"
      });
    }

    if (!invoice_data) {
      return res.status(400).json({
        error: "invoice_data is required"
      });
    }

    const { invoice_no, invoice_date, customer_name, gstin } = invoice_data;
    if (!invoice_data) {
      return res.status(400).json({
        error: "invoice_data is required"
      });
    }

    const { invoice_no, invoice_date, customer_name, gstin } = invoice_data;

    if (!invoice_no?.trim()) {
    if (!invoice_no?.trim()) {
      return res.status(400).json({
        error: "invoice_no is required"
        error: "invoice_no is required"
      });
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 2: GET COMPANY ID ✅
    // ─────────────────────────────────────────────────────────────

    console.log(`🔍 Looking up company: ${company.trim()}`);

    const companyResult = await pool.query(
    // ─────────────────────────────────────────────────────────────
    // STEP 2: GET COMPANY ID ✅
    // ─────────────────────────────────────────────────────────────

    console.log(`🔍 Looking up company: ${company.trim()}`);

    const companyResult = await pool.query(
      `
      SELECT id
      FROM app_test.companies
      WHERE name = $1
      LIMIT 1
      `,
      [company.trim()]
      [company.trim()]
    );

    if (companyResult.rows.length === 0) {
      return res.status(400).json({
        status: "error",
        message: `Company not found: ${company.trim()}`
      });
    }

    const companyId = companyResult.rows[0].id;
    console.log(`✅ Company found: ID ${companyId}`);

    // ─────────────────────────────────────────────────────────────
    // STEP 3: INSERT INVOICE WITH COMPANY_ID ✅
    // ─────────────────────────────────────────────────────────────

    console.log(`📝 Creating new purchase invoice: ${invoice_no}`);

    const insertResult = await pool.query(
      `
      INSERT INTO app_test.invoice_extractions
      (
        company_id,
        company_name,
        vendor_name,
        gstin,
        invoice_no,
        invoice_date,
        raw_json,
        sync_status,
        created_at,
        updated_at
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        NOW(),
        NOW()
      )
      RETURNING id
      `,
      [
        companyId,                    // $1 ✅ COMPANY_ID
        company?.trim(),              // $2
        customer_name || "",          // $3
        gstin || "",                  // $4
        invoice_no?.trim(),           // $5
        invoice_date || "",           // $6
        JSON.stringify(invoice_data), // $7 ✅ FULL invoice_data as JSON
        "pending"                     // $8
      ]
    );

    const invoiceId = insertResult.rows[0].id;
    console.log(`✅ Purchase Invoice created: ID ${invoiceId}`);

    // ─────────────────────────────────────────────────────────────
    // STEP 4: QUEUE THE JOB
    // ─────────────────────────────────────────────────────────────

    const job = await purchaseQueue.add(
      "push-invoice",
      { invoiceId },
      {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000
        },
        jobId: getPurchaseJobId(invoiceId)
      }
    );

    console.log(`📤 Purchase Invoice job queued: ${job.id}`);

    return res.status(200).json({
      status: "success",
      message: "Purchase Invoice queued for processing",
      jobId: job.id,
      invoiceId,
      companyId
    });

  } catch (error) {
    console.error("Push invoice error:", error.message);
    return res.status(500).json({
      error: error.message
    });
  }
});

export default router;
