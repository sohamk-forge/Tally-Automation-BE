import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";

const router = express.Router();

router.get("/stock/group-summary", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = validateCompanyId(req.query.company_id);

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: "Valid company_id required"
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
         company_id,
         company_name,
         group_name,
         item_name,
         hsn_code,
         quantity,
         stock_value,
         created_at
       FROM app_test.stock_group_summary
       WHERE company_id = $1
       ORDER BY id DESC`,
      [companyId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        status: "error",
        source: "database",
        company_id: companyId,
        message: "No stock group summary found",
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
    console.error("❌ STOCK GROUP SUMMARY API ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;