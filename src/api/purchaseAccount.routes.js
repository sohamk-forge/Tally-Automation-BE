import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess } from "../utils/companyAccess.js";

const router = express.Router();

router.get("/closing-balance", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const company = req.query.company?.trim();

    if (!company) {
      return res.status(400).json({
        success: false,
        message: "company query parameter is required"
      });
    }

    const companyResult = await pool.query(
      `SELECT id FROM app_test.companies
       WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [company]
    );

    if (!companyResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: `Company not found: "${company}"`
      });
    }

    const companyId = companyResult.rows[0].id;

    const hasAccess = await checkCompanyAccess(userId, companyId);
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "You don't have access to this company"
      });
    }

    const result = await pool.query(
      `SELECT closing_balance, closing_balance_type
       FROM app_test.all_ledger_details
       WHERE company_id = $1
         AND LOWER(parent_group) LIKE '%purchase%'`,
      [companyId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: `No "Purchase" group ledgers found for "${company}"`
      });
    }

    let closingBalance = 0;
    for (const row of result.rows) {
      const amount = Math.abs(Number(row.closing_balance) || 0);
      closingBalance +=
        (row.closing_balance_type || "").toUpperCase() === "CR"
          ? -amount
          : amount;
    }

    return res.status(200).json({
      success: true,
      company_id: companyId,
      company,
      closing_balance: Math.abs(Number(closingBalance.toFixed(2))),
      source: "database"
    });

  } catch (err) {
    console.error("❌ Purchase closing-balance error:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

export default router;