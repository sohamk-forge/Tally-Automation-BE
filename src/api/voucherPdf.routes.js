import express from "express";
import db from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { normalizeVoucherRow } from "../services/voucherPdf.service.js";
import { renderVoucherPdf } from "../services/voucherPdfRenderer.service.js";
import { getCompanyInfo } from "../services/companyInfo.service.js";

const router = express.Router();

/* ==========================================================
   Mount this router at: app.use("/api/v1/voucher", ...requireSessionOrApiKey(), voucherPdfRoutes)

   GET /api/v1/voucher?company_id=1&voucher_type=Journal&party_ledger_name=Rohit%20Kadam&from=2025-01-01&to=2026-12-31
     -> lists vouchers (grouped by voucher_type) for the transactions table

   GET /api/v1/voucher/:id/pdf
     -> generates and streams back the PDF for one voucher row
   ========================================================== */

// ---- LIST: GET /api/v1/voucher ----
router.get("/", async (req, res) => {
  try {
    const { company_id, party_ledger_name, voucher_type, from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: "Query params 'from' and 'to' (YYYY-MM-DD) are required" });
    }

    const conditions = [];
    const params = [];

    if (company_id) {
      params.push(company_id);
      conditions.push(`company_id = $${params.length}`);
    }
    if (party_ledger_name) {
      params.push(party_ledger_name);
      conditions.push(`party_ledger_name = $${params.length}`);
    }
    if (voucher_type) {
      params.push(voucher_type);
      conditions.push(`voucher_type ILIKE $${params.length}`);
    }
    params.push(from);
    conditions.push(`voucher_date >= $${params.length}`);
    params.push(to);
    conditions.push(`voucher_date <= $${params.length}`);

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT id, company_id, company_name, voucher_date, voucher_type, voucher_number,
             party_ledger_name, narration, debit_amount, credit_amount, balance
      FROM ${DB_SCHEMA}.vouchers
      ${whereClause}
      ORDER BY voucher_date ASC, id ASC
    `;

    const result = await db.query(sql, params);

    // Group by voucher_type so the UI can render separate sections per type
    const grouped = {};
    for (const row of result.rows) {
      const key = row.voucher_type || "Other";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(row);
    }

    return res.json({ success: true, data: grouped });
  } catch (err) {
    console.error("GET /api/v1/voucher error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---- PDF: GET /api/v1/voucher/:id/pdf ----
router.get("/:id/pdf", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "Voucher id is required" });
    }

    const result = await db.query(
      `SELECT * FROM ${DB_SCHEMA}.vouchers WHERE id = $1 LIMIT 1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ error: `Voucher with id ${id} not found` });
    }
    if (!row.company_id) {
      return res.status(422).json({ error: `Voucher ${id} has no company_id - cannot resolve letterhead` });
    }

    const companyInfo = await getCompanyInfo(row.company_id);
    const voucher = normalizeVoucherRow(row, companyInfo);

    if (!voucher.templateKey) {
      return res.status(422).json({
        error: `Voucher type "${voucher.voucherType}" is not one of the supported layouts (Contra, Journal, Payment, Receipt, Purchase, Sales)`,
      });
    }

    const pdfBuffer = await renderVoucherPdf(voucher);

res.set({
  "Content-Type": "application/pdf",
  "Content-Disposition": `inline; filename="${voucher.voucherType}_${voucher.voucherNumber}.pdf"`,
  "Content-Length": pdfBuffer.length,   // ← add this
});
return res.end(pdfBuffer);              // ← change res.send to res.end
  } catch (err) {
    console.error("GET /api/v1/voucher/:id/pdf error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;