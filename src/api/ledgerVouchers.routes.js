import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";

const router = express.Router();

router.get("/ledger-vouchers", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = validateCompanyId(req.query.company_id);
    const fromDate = req.query.fromDate?.trim();
    const toDate = req.query.toDate?.trim();
    const voucherType = req.query.voucherType?.trim();
    const party = req.query.party?.trim();

    if (!companyId || !fromDate || !toDate) {
      return res.status(400).json({
        status: "error",
        message: "Valid company_id, fromDate and toDate are required"
      });
    }

    const hasAccess = await checkCompanyAccess(userId, companyId);
    if (!hasAccess) {
      return res.status(403).json({
        status: "error",
        message: "You don't have access to this company"
      });
    }

    let query = `
      SELECT
        id,
        company_id,
        company_name,
        voucher_date,
        voucher_type,
        voucher_number,
        party_ledger_name,
        ledger_entries,
        narration,
        debit_amount,
        credit_amount,
        balance,
        created_at,
        updated_at
      FROM app_test.vouchers
      WHERE company_id = $1
        AND DATE(voucher_date) BETWEEN $2 AND $3
    `;

    const values = [companyId, fromDate, toDate];
    let paramIndex = 4;

    if (voucherType) {
      query += `
        AND LOWER(voucher_type) LIKE LOWER($${paramIndex})
      `;
      values.push(`%${voucherType}%`);
      paramIndex++;
    }

    if (party && party !== "undefined" && party !== "null") {
      query += `
        AND (
          LOWER(party_ledger_name) LIKE LOWER($${paramIndex})
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(ledger_entries) e
            WHERE LOWER(e->>'LEDGERNAME') LIKE LOWER($${paramIndex})
          )
        )
      `;
      values.push(`%${party}%`);
      paramIndex++;
    }

    query += `
      ORDER BY voucher_date DESC, id DESC
    `;

    const result = await pool.query(query, values);

    return res.status(200).json({
      status: "success",
      source: "database",
      company_id: companyId,
      fromDate,
      toDate,
      total: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error("❌ LEDGER VOUCHER DB ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;