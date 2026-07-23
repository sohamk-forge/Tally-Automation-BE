import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";

const router = express.Router();

router.get("/parent-groups", authMiddleware, async (req, res) => {
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
      `SELECT group_name
       FROM app_test.parent_groups
       WHERE company_id = $1
       ORDER BY group_name ASC`,
      [companyId]
    );

    const parentGroups = result.rows.map((row) => row.group_name);

    return res.status(200).json({
      status: "success",
      source: "database",
      company_id: companyId,
      total: parentGroups.length,
      parent_groups: parentGroups
    });

  } catch (err) {
    console.error("❌ PARENT GROUP DB ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;