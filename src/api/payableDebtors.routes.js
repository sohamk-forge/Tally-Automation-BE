import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";

const router = express.Router();

router.get("/payable-debtors", authMiddleware, async (req, res) => {
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
         company_id,
         company_name,
         group_name,
         parent_group,
         opening_balance,
         closing_balance
       FROM app_test.group_balances
       WHERE company_id = $1`,
      [companyId]
    );

    const debtors = result.rows.find(
      (row) => row.group_name === "Sundry Debtors"
    );

    const creditors = result.rows.find(
      (row) => row.group_name === "Sundry Creditors"
    );

    return res.status(200).json({
      status: "success",
      source: "database",
      company_id: companyId,
      data: {
        debtors,
        creditors
      }
    });

  } catch (err) {
    console.error("❌ GROUP BALANCE DB ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;