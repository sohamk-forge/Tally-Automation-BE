import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";

const router = express.Router();

router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = validateCompanyId(req.query.company_id);

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: "Valid company_id query parameter required"
      });
    }

    const hasAccess = await checkCompanyAccess(userId, companyId);
    if (!hasAccess) {
      return res.status(403).json({
        status: "error",
        message: "You don't have access to this company"
      });
    }

    const result = await pool.query(
      `SELECT *
       FROM app_test.bank_accounts
       WHERE company_id = $1
       ORDER BY ledger_name ASC`,
      [companyId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        status: "error",
        source: "database",
        company_id: companyId,
        message: "No bank accounts found",
        total: 0,
        data: []
      });
    }

    return res.status(200).json({
      status: "success",
      source: "database",
      company_id: companyId,
      total: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error("❌ GROUP SUMMARY BANK DB ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;