// =========================================
// src/api/invoices.routes.js
// =========================================

import express from "express";
import pool from "../db/index.js";

const router = express.Router();

router.post("/invoices", async (req, res) => {

  console.log("BODY RECEIVED:");
  console.log(JSON.stringify(req.body, null, 2));

  try {

    const {
      company,
      invoice_data
    } = req.body;

    if (!company || !invoice_data) {
      return res.status(400).json({
        status: "error",
        message: "company and invoice_data required"
      });
    }

    console.log("");
    console.log("====================================");
    console.log("🚀 INVOICE API HIT");
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

    // ✅ Check if invoice already exists for this company
    const existingInvoice = await pool.query(
      `
      SELECT id
      FROM app_test.invoice_extractions
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
        UPDATE app_test.invoice_extractions
        SET
          vendor_name = $1,
          gstin = $2,
          invoice_date = $3,
          godown_name = $4,
          raw_json = $5,
          sync_status = 'pending',
          error_count = 0,
          last_error = NULL,
          error_message = NULL,
          updated_at = NOW()
        WHERE id = $6
        RETURNING id
        `,
        [
          invoice_data.vendor_name || "",
          invoice_data.gstin || "",
          invoice_data.invoice_date || "",
          invoice_data.godown_name || "",
          invoice_data,
          existingInvoice.rows[0].id
        ]
      );

      invoiceId = updateResult.rows[0].id;
      console.log(`✅ Invoice updated: ${invoiceId}`);

    } else {

      console.log(`Creating new invoice: ${invoice_data.invoice_no}`);

      const result = await pool.query(
        `
        INSERT INTO app_test.invoice_extractions
        (
          company_id,
          company_name,
          vendor_name,
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
          invoice_data.vendor_name || "",
          invoice_data.gstin || "",
          invoice_data.invoice_no || "",
          invoice_data.invoice_date || "",
          invoice_data.godown_name || "",
          invoice_data
        ]
      );

      invoiceId = result.rows[0].id;
      console.log(`✅ New invoice created: ${invoiceId}`);
    }

    console.log(`✅ Invoice set to pending: ${invoiceId} (will be picked up by polling worker)`);

    return res.status(200).json({
      status: "success",
      message: existingInvoice.rows.length > 0
        ? "Invoice updated and queued successfully"
        : "Invoice created and queued successfully",
      invoice_id: invoiceId,
      company_id: companyId,
      sync_status: "pending"
    });

  } catch (err) {

    console.log("");
    console.log("====================================");
    console.log("💥 INVOICE API ERROR");
    console.log("====================================");
    console.log(err);

    return res.status(500).json({
      status: "error",
      message: err.message
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

    let query = `SELECT * FROM app_test.invoice_extractions WHERE 1=1`;
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