import express from "express";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { getNumberingProfile } from "../services/voucherNumberingProfile.service.js";

const router = express.Router();

/* =================================
   GET /api/voucher-types?company_id=1
   Synced Tally voucher types, grouped by their root built-in type, so the UI
   can offer them under Receipt / Payment / Contra. Mounted behind
   requireSessionAndCompany, which checks company access.
================================= */
router.get("/voucher-types", async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) {
      return res.status(400).json({ status: "error", message: "company_id is required" });
    }

    const result = await pool.query(
      `SELECT name, parent, base_type
         FROM ${DB_SCHEMA}.voucher_types
        WHERE company_id = $1
          AND is_active = true
          AND base_type IN ('receipt', 'payment', 'contra')
        ORDER BY name ASC`,
      [company_id]
    );

    const grouped = { receipt: [], payment: [], contra: [] };
    for (const r of result.rows) grouped[r.base_type].push(r.name);

    return res.status(200).json({ status: "success", company_id, voucherTypes: grouped });
  } catch (err) {
    console.log("GET VOUCHER TYPES ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/* =================================
   GET /api/voucher-types/numbering-profile?company_id=1
   How each voucher type (sales, purchase, receipt, payment, contra, journal)
   is numbered: Tally's setting plus what the synced vouchers actually look
   like (format, gaps, duplicates). Mounted behind requireSessionAndCompany.
================================= */
router.get("/voucher-types/numbering-profile", async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) {
      return res.status(400).json({ status: "error", message: "company_id is required" });
    }
    const profile = await getNumberingProfile(company_id);
    return res.status(200).json({ status: "success", company_id, profile });
  } catch (err) {
    console.log("NUMBERING PROFILE ERROR:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;
