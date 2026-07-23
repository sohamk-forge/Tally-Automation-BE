import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess } from "../utils/companyAccess.js";

const router = express.Router();

router.get("/sales-items", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const company = req.query.company;

    if (!company) {
      return res.status(400).json({
        status: "error",
        message: "company required"
      });
    }

    const companyResult = await pool.query(
      `SELECT id FROM app_test.companies
       WHERE TRIM(name) = TRIM($1) LIMIT 1`,
      [company]
    );

    const companyId = companyResult.rows[0]?.id;

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: `Company not found: ${company}`
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
         company_name,
         description,
         actual_quantity,
         billed_quantity,
         billing,
         total_amount,
         created_at
       FROM app_test.sales_items
       WHERE company_id = $1
       ORDER BY id DESC`,
      [companyId]
    );

    return res.status(200).json({
      status: "success",
      source: "database",
      company_id: companyId,
      company,
      total: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error("❌ SALES ITEMS ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;