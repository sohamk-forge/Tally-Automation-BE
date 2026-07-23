import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";

const router = express.Router();

router.get("/profit-loss", authMiddleware, async (req, res) => {
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
         company_name,
         from_date,
         to_date,
         total_sales,
         total_purchase,
         stock_value,
         gross_profit,
         net_profit,
         profit_margin,
         created_at,
         updated_at
       FROM app_test.profit_loss
       WHERE company_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [companyId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        status: "error",
        source: "database",
        message: "No profit loss data found",
        company_id: companyId,
        data: []
      });
    }

    const row = result.rows[0];

    return res.status(200).json({
      status: "success",
      source: "database",
      company_id: companyId,
      dashboard: {
        id: Number(row.id),
        company_id: row.company_id,
        company_name: row.company_name,
        from_date: row.from_date,
        to_date: row.to_date,
        total_sales: Number(row.total_sales),
        total_purchase: Number(row.total_purchase),
        stock_value: Number(row.stock_value),
        gross_profit: Number(row.gross_profit),
        net_profit: Number(row.net_profit),
        profit_margin: Number(row.profit_margin),
        created_at: row.created_at,
        updated_at: row.updated_at
      }
    });

  } catch (err) {
    console.error("❌ PROFIT LOSS DB ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;