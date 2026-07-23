import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";

const router = express.Router();

router.get("/pull/stock-alert", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = validateCompanyId(req.query.company_id);

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: "Valid company_id is required"
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
         item_name,
         minimum_alert_quantity,
         current_quantity,
         shortage_quantity,
         is_low_stock
       FROM app_test.stock_alerts
       WHERE company_id = $1
         AND is_active = true
       ORDER BY is_low_stock DESC, item_name`,
      [companyId]
    );

    return res.json({
      status: "success",
      company_id: companyId,
      total: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error("❌ STOCK ALERT ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;