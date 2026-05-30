// src/api/invoices.routes.js

import express from "express";
import pool from "../db/index.js";

import { generateXml } from "../services/xmlGenerator.js";
import { sendToTally } from "../services/tallyClient.js";

const router = express.Router();

router.post("/invoices", async (req, res) => {
  try {
    const { company, invoice_data } = req.body;

    if (!company || !invoice_data) {
      return res.status(400).json({
        status: "error",
        message: "company and invoice_data required",
      });
    }

    // 1. Save in DB
    const dbResult = await pool.query(
      `
      INSERT INTO app_test.invoice_extractions
      (
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
        $1,$2,$3,$4,$5,$6,
        'pending',
        NOW(),
        NOW()
      )
      RETURNING id
      `,
      [
        company.trim(),
        invoice_data.vendor_name || "",
        invoice_data.vendor_gstin || "",
        invoice_data.invoice_no || "",
        invoice_data.invoice_date || "",
        invoice_data,
      ]
    );

    const invoiceId = dbResult.rows[0].id;

    // 2. Generate XML
    const xml = await generateXml({
      company,
      ...invoice_data,
    });

    console.log("📤 XML GENERATED");

    // 3. Send to Tally
    const tallyResponse = await sendToTally(xml);

    // 4. Update status
    await pool.query(
      `
      UPDATE app_test.invoice_extractions
      SET
        sync_status = 'completed',
        updated_at = NOW()
      WHERE id = $1
      `,
      [invoiceId]
    );

    // 5. Return response
    return res.status(200).json({
      status: "success",
      invoice_id: invoiceId,
      tally_response: tallyResponse,
    });

  } catch (err) {

    console.log("INVOICE ERROR:", err.message);

    return res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

export default router;