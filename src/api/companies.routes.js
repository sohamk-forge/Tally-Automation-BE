import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js"; // ✅ Import auth middleware

const router = express.Router();

/* =========================================
   GET ALL COMPANIES (USER-SCOPED)
   GET /api/companies
   Only returns companies assigned to logged-in user
========================================= */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id; // ✅ Get user_id from JWT/pairing token

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated"
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // COUNT TOTAL - Only companies this user has access to
    const totalResult = await pool.query(
      `SELECT COUNT(*) FROM app_test.user_companies uc
       WHERE uc.user_id = $1`,
      [userId]
    );

    const total = parseInt(totalResult.rows[0].count);

    // FETCH ALL COMPANIES - Only assigned to this user ✅
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
    console.log("❌ COMPANY GET ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

/* =========================================
   GET ALL COMPANIES (SIMPLE LIST - USER-SCOPED)
   GET /api/companies/all/list
   ✅ MUST BE BEFORE /:id (specific routes first!)
   Returns simple list of user's companies
========================================= */
router.get("/all/list", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id; // ✅ Get user_id from JWT/pairing token

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated"
      });
    }

    // ✅ Only companies assigned to this user
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
    console.log("❌ COMPANY LIST ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

/* =========================================
   GET SINGLE COMPANY BY ID (USER-SCOPED)
   GET /api/companies/:id
   ✅ AFTER /all/list (dynamic routes last!)
   Only if user has access to this company
========================================= */
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id; // ✅ Get user_id from JWT/pairing token
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated"
      });
    }

    // ✅ Check: Does this user have access to this company?
    const result = await pool.query(
      `SELECT 
         c.id, 
         c.name, 
         c.financial_year_start, 
         c.financial_year_end
       FROM app_test.user_companies uc
       JOIN app_test.companies c ON uc.company_id = c.id
       WHERE uc.user_id = $1 AND c.id = $2`,
      [userId, id]
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
    console.log("❌ COMPANY GET BY ID ERROR:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;