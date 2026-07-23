import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { validateCompanyId } from "../utils/companyAccess.js";

const router = express.Router();

router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated"
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const totalResult = await pool.query(
      `SELECT COUNT(*) FROM app_test.user_companies uc
       WHERE uc.user_id = $1`,
      [userId]
    );

    const total = parseInt(totalResult.rows[0].count);

    const result = await pool.query(
      `SELECT 
         c.id, 
         c.name, 
         c.financial_year_start, 
         c.financial_year_end
       FROM app_test.user_companies uc
       JOIN app_test.companies c ON uc.company_id = c.id
       WHERE uc.user_id = $1
       ORDER BY c.id DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return res.json({
      status: "success",
      message: "Companies fetched successfully",
      page,
      limit,
      total,
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error("❌ COMPANY GET ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

router.get("/all/list", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated"
      });
    }

    const result = await pool.query(
      `SELECT 
         c.id, 
         c.name, 
         c.financial_year_start, 
         c.financial_year_end
       FROM app_test.user_companies uc
       JOIN app_test.companies c ON uc.company_id = c.id
       WHERE uc.user_id = $1
       ORDER BY c.id DESC`,
      [userId]
    );

    return res.json({
      status: "success",
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error("❌ COMPANY LIST ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = validateCompanyId(req.params.id);

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated"
      });
    }

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: "Valid company_id required"
      });
    }

    const result = await pool.query(
      `SELECT 
         c.id, 
         c.name, 
         c.financial_year_start, 
         c.financial_year_end
       FROM app_test.user_companies uc
       JOIN app_test.companies c ON uc.company_id = c.id
       WHERE uc.user_id = $1 AND c.id = $2`,
      [userId, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Company not found or you don't have access"
      });
    }

    return res.json({
      status: "success",
      data: result.rows[0]
    });

  } catch (err) {
    console.error("❌ COMPANY GET BY ID ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;