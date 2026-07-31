import express from "express";
import pool from "../db/index.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";
import { salesQueue, getSalesJobId } from "../queues/sales.queue.js";

const router = express.Router();

function safeNumber(value) {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
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
      narration
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

    // const hasAccess = await checkCompanyAccess(userId, companyId);
    // if (!hasAccess) {
    //   return res.status(403).json({
    //     status: "error",
    //     message: "You don't have access to this company"
    //   });
    // }

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
      // Maharashtra → CGST + SGST
      const halfRate = gstPercent / 2;
      cleanInvoiceData.cgst_amount = Number(
        ((taxableAmount * halfRate) / 100).toFixed(2)
      );
      cleanInvoiceData.sgst_amount = Number(
        ((taxableAmount * halfRate) / 100).toFixed(2)
      );
      cleanInvoiceData.igst_amount = 0;

    } else if (stateCode) {
      // Other state → IGST
      cleanInvoiceData.cgst_amount = 0;
      cleanInvoiceData.sgst_amount = 0;
      cleanInvoiceData.igst_amount = gstAmount;

    } else {
      // No GSTIN → default CGST + SGST (same as bulk)
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
    // CHECK EXISTING OR INSERT NEW
    // =========================================

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

    const jobId = getSalesJobId(invoiceId);
    const existingJob = await salesQueue.getJob(jobId);
    if (existingJob) {
      await existingJob.remove();
      console.log(`Old job removed: ${jobId}`);
    }

    const job = await salesQueue.add(
      "sales-invoice",
      { salesId: invoiceId, userId },
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

    if (error_only === 'true') {
      query += ` AND error_count > 0`;
    }

    query += ` ORDER BY id DESC`;

    const result = await pool.query(query, params);

    return res.status(200).json({
      status: "success",
      company_id: companyId,
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

router.delete("/sales-invoices/:id", async (req, res) => {
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

    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({
        status: "error",
        message: "Valid invoice id required"
      });
    }

    // Optional: fetch first to confirm it exists (and to get company_id for access check)
    const existing = await pool.query(
      `SELECT id, company_id FROM app_test.sales_invoice_extractions WHERE id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Invoice not found"
      });
    }

    // const hasAccess = await checkCompanyAccess(userId, existing.rows[0].company_id);
    // if (!hasAccess) {
    //   return res.status(403).json({
    //     status: "error",
    //     message: "You don't have access to this company"
    //   });
    // }

    // Remove any queued job for this invoice so it doesn't get processed after deletion
    const jobId = getSalesJobId(id);
    const existingJob = await salesQueue.getJob(jobId);
    if (existingJob) {
      await existingJob.remove();
      console.log(`Old job removed for deleted invoice: ${jobId}`);
    }

    await pool.query(
      `DELETE FROM app_test.sales_invoice_extractions WHERE id = $1`,
      [id]
    );

    console.log(`🗑️ Invoice deleted: ${id}`);

    return res.status(200).json({
      status: "success",
      message: "Invoice deleted successfully",
      invoice_id: Number(id)
    });

  } catch (err) {
    console.error("DELETE invoice error:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;