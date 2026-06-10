import express from "express";
import pool from "../db/index.js";

const router = express.Router();

/* =================================
   GET ALL GODOWNS
   GET /api/godowns?company_id=1
================================= */
router.get("/godowns", async (req, res) => {
  try {
    const { company_id } = req.query;

    if (!company_id) {
      return res.status(400).json({ status: "error", message: "company_id is required" });
    }

    const result = await pool.query(
      `SELECT id, godown_name, created_at, updated_at
       FROM app_test.godown_details
       WHERE company_id = $1
       ORDER BY godown_name ASC`,
      [company_id]
    );

    return res.status(200).json({
      status     : "success",
      company_id,
      total      : result.rows.length,
      godowns    : result.rows
    });

  } catch (err) {
    console.log("GET GODOWNS ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =================================
   FIND SINGLE GODOWN BY NAME
   GET /api/godowns/find?company_id=1&name=Main Location
================================= */
router.get("/godowns/find", async (req, res) => {
  try {
    const { company_id, name } = req.query;

    if (!company_id || !name) {
      return res.status(400).json({ status: "error", message: "company_id and name are required" });
    }

    const result = await pool.query(
      `SELECT id, godown_name, created_at, updated_at
       FROM app_test.godown_details
       WHERE company_id = $1
         AND LOWER(TRIM(godown_name)) = LOWER(TRIM($2))
       LIMIT 1`,
      [company_id, name]
    );

    if (!result.rows.length) {
      return res.status(404).json({ status: "error", message: `Godown not found: ${name}` });
    }

    return res.status(200).json({
      status  : "success",
      godown  : result.rows[0]
    });

  } catch (err) {
    console.log("FIND GODOWN ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;