import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
import { requireFeature } from "../utils/featureFlags.js";

const FEATURE_KEY = "bulk_purchase_reconciliation";

const router = express.Router();

/*
====================================
SAVE / UPDATE VENDOR GSTIN MAPPING
Same upsert shape as purchaseLedgerMapping.routes.js's /ledger-mapping,
keyed on (company_id, vendor_code) instead of company_id alone — a
company has one vendor per Purchase Report "Vendor Code", not one row
total.
====================================
*/
router.post("/vendor-gstin-mapping", async (req, res) => {
  try {
    const { company_id, vendor_code, vendor_name, gstin, state } = req.body;

    if (!company_id) {
      return res.status(400).json({ status: "error", message: "company_id required" });
    }
    if (!vendor_code) {
      return res.status(400).json({ status: "error", message: "vendor_code required" });
    }

    if (!(await requireFeature(company_id, FEATURE_KEY, res))) return;

    await pool.query(
      `
      INSERT INTO ${DB_SCHEMA}.vendor_gstin_mappings (company_id, vendor_code, vendor_name, gstin, state, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
      ON CONFLICT (company_id, vendor_code) DO UPDATE SET
        vendor_name = EXCLUDED.vendor_name,
        gstin = EXCLUDED.gstin,
        state = EXCLUDED.state,
        updated_at = NOW()
      `,
      [company_id, vendor_code, vendor_name || null, gstin || null, state || null]
    );

    return res.status(200).json({ status: "success", message: "Vendor GSTIN mapping saved" });
  } catch (err) {
    console.error("Vendor GSTIN mapping save error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

/*
====================================
LIST MAPPINGS FOR A COMPANY
====================================
*/
router.get("/vendor-gstin-mapping/:companyId", async (req, res) => {
  try {
    const { companyId } = req.params;

    if (!(await requireFeature(companyId, FEATURE_KEY, res))) return;

    const result = await pool.query(
      `
      SELECT vendor_code, vendor_name, gstin, state, updated_at
      FROM ${DB_SCHEMA}.vendor_gstin_mappings
      WHERE company_id = $1
      ORDER BY vendor_name NULLS LAST, vendor_code
      `,
      [companyId]
    );

    return res.status(200).json({ status: "success", data: result.rows });
  } catch (err) {
    console.error("Vendor GSTIN mapping list error:", err);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;
