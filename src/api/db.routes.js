import express from "express";
import pool from "../db/index.js";

const router = express.Router();

router.get("/test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");

    res.json({
      status: "success",
      data: result.rows[0]
    });

  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;