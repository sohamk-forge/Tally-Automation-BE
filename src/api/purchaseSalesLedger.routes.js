import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";

const router = express.Router();

router.get("/purchase-sales-ledgers", authMiddleware, async (req, res) => {
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
      `SELECT
         id,
         company_id,
         ledger_name,
         parent_group,
         ledger_type,
         created_at,
         updated_at
       FROM app_test.company_purchase_sales_ledgers
       WHERE company_id = $1
       ORDER BY ledger_name`,
      [companyId]
    );

    return res.status(200).json({
      status: "success",
      source: "database",
      company_id: companyId,
      total: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error("❌ PURCHASE SALES LEDGER DB ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;