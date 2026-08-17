import express from "express";
import pool from "../db/index.js";
import { safeEnqueuePurchase } from "../queues/purchase.queue.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";
import { DB_SCHEMA } from "../config/db.js";

const router = express.Router();

router.post("/invoices", async (req, res) => {
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

    const { company, invoice_data } = req.body;

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

    console.log(`🔍 Looking up company: ${company.trim()}`);

    // Scoped to this acting user's own pairing, not a bare global name
    // match — two unrelated companies can share a name, and a global
    // lookup here would silently resolve to whichever row Postgres
    // happens to return, possibly someone else's company. This also
    // doubles as the ownership check (a company this user has no access
    // to simply won't match), replacing the old checkCompanyAccess call
    // that checked the vestigial user_companies table.
    const companyResult = await pool.query(
      `
      SELECT c.id
      FROM ${DB_SCHEMA}.companies c
      JOIN ${DB_SCHEMA}.connector_pairing_tokens cpt ON cpt.company_id = c.id
      WHERE cpt.user_id = $1
        AND cpt.is_used = TRUE
        AND lower(trim(c.name)) = lower(trim($2))
      LIMIT 1
      `,
      [userId, company.trim()]
    );

    if (!companyResult.rows.length) {
      return res.status(400).json({
        status: "error",
        message: `Company not found: ${company.trim()}`
      });
    }

    const companyId = companyResult.rows[0].id;
    console.log(`✅ Company found: ID ${companyId}`);

    console.log(`📝 Creating new purchase invoice: ${invoice_no}`);

    const insertResult = await pool.query(
      `INSERT INTO ${DB_SCHEMA}.invoice_extractions
       (
         company_id,
         company_name,
         vendor_name,
         gstin,
         invoice_no,
         invoice_date,
         raw_json,
         sync_status,
         user_id,
         created_at,
         updated_at
       )
       VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       RETURNING id`,
      [
        companyId,
        company?.trim(),
        customer_name || "",
        gstin || "",
        invoice_no?.trim(),
        invoice_date || "",
        JSON.stringify(invoice_data),
        "pending",
        userId
      ]
    );

    const invoiceId = insertResult.rows[0].id;
    console.log(`✅ Purchase Invoice created: ID ${invoiceId}`);

    const { jobId } = await safeEnqueuePurchase(invoiceId, userId);

    console.log(`📤 Purchase Invoice job queued: ${jobId}`);

    return res.status(200).json({
      status: "success",
      message: "Purchase Invoice queued for processing",
      jobId,
      invoiceId,
      companyId
    });

  } catch (error) {
    console.error("❌ Push invoice error:", error.message);
    return res.status(500).json({
      error: error.message
    });
  }
});

export default router;