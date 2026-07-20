import express from "express";
import pool from "../db/index.js";
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
      return res.status(400).json({
        error: "Company is required"
      });
    }

    if (!invoice_data) {
      return res.status(400).json({
        error: "invoice_data is required"
      });
    }

    const { invoice_no, invoice_date, customer_name, gstin } = invoice_data;

    if (!invoice_no?.trim()) {
      return res.status(400).json({
        error: "invoice_no is required"
      });
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 2: GET COMPANY ID ✅
    // ─────────────────────────────────────────────────────────────

    console.log(`🔍 Looking up company: ${company.trim()}`);

    const companyResult = await pool.query(
      `
      SELECT id
      FROM ${DB_SCHEMA}.companies
      WHERE TRIM(name) = TRIM($1)
      LIMIT 1
      `,
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
      INSERT INTO ${DB_SCHEMA}.invoice_extractions
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
      status: "error",
      error: error.message
    });
  }
});

// ✅ GET API FOR INVOICES
router.get("/invoices", async (req, res) => {
  try {
    const { company_id, company_name, sync_status, invoice_no, error_only } = req.query;

    if (!company_id && !company_name) {
      return res.status(400).json({
        status: "error",
        message: "company_id or company_name query parameter required"
      });
    }

    let query = `SELECT * FROM ${DB_SCHEMA}.invoice_extractions WHERE 1=1`;
    const params = [];

    if (company_id) {
      query += ` AND company_id = $${params.length + 1}`;
      params.push(company_id);
    }

    if (company_name) {
      query += ` AND TRIM(company_name) = TRIM($${params.length + 1})`;
      params.push(company_name);
    }

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
