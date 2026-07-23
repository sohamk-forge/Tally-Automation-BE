import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";

const router = express.Router();

router.get("/find", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = validateCompanyId(req.query.company_id);
    const name = req.query.name?.trim();

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: "Valid company_id is required"
      });
    }

    if (!name) {
      return res.status(400).json({
        status: "error",
        message: "name is required"
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
      `SELECT id, godown_name, created_at, updated_at
       FROM app_test.godown_details
       WHERE company_id = $1
         AND LOWER(TRIM(godown_name)) = LOWER(TRIM($2))
       LIMIT 1`,
      [companyId, name]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        status: "error",
        message: `Godown not found: ${name}`
      });
    }

    return res.status(200).json({
      status: "success",
      godown: result.rows[0]
    });

  } catch (err) {
    console.error("❌ FIND GODOWN ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

router.get("/", authMiddleware, async (req, res) => {
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
      `SELECT id, godown_name, created_at, updated_at
       FROM app_test.godown_details
       WHERE company_id = $1
       ORDER BY godown_name ASC`,
      [companyId]
    );

    return res.status(200).json({
      status: "success",
      company_id: companyId,
      total: result.rows.length,
      godowns: result.rows
    });

  } catch (err) {
    console.error("❌ GET GODOWNS ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;