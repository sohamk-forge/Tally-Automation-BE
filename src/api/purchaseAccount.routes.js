import express from "express";
import pool from "../db/index.js";

const router = express.Router();

router.get("/closing-balance", async (req, res) => {
  try {
    const { company } = req.query;

    if (!company) {
      return res.status(400).json({
        success: false,
        message: "company query parameter is required"
      });
    }

    const result = await pool.query(
      `SELECT closing_balance, closing_balance_type
         FROM app_test.all_ledger_details
        WHERE LOWER(company_name) = LOWER($1)
          AND LOWER(parent_group) LIKE '%purchase%'`,
      [company]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: `No "Purchase" group ledgers found for "${company}"`
      });
    }

    let closingBalance = 0;
    for (const row of result.rows) {
      const amount = Math.abs(Number(row.closing_balance) || 0);
      // Purchase is a Dr-nature group; add Dr, subtract Cr (contra/returns)
      closingBalance +=
        (row.closing_balance_type || "").toUpperCase() === "CR"
          ? -amount
          : amount;
    }

    return res.status(200).json({
      success: true,
      company,
      closing_balance: Math.abs(Number(closingBalance.toFixed(2))),
      source: "database"
    });

  } catch (err) {
    console.error("purchase closing-balance error:", err.message);

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

export default router;