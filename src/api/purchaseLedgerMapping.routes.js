import express from "express";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/*
====================================
SAVE / UPDATE LEDGER MAPPING
====================================
*/

router.post("/ledger-mapping", async (req, res) => {

  try {

    const {
      company_id,
      purchase_ledger,        // ✅ NEW! Actual ledger name e.g. "Purchase @18%"
      invoice_parent_group,
      cgst_ledger,
      sgst_ledger,
      igst_ledger,
      tds_ledger,
      cess_ledger,
      rounded_off_ledger
    } = req.body;

    if (!company_id) {
      return res.status(400).json({
        status: "error",
        message: "company_id required"
      });
    }

    const existing = await pool.query(
      `
      SELECT id
      FROM ${DB_SCHEMA}.company_ledger_mappings
      WHERE company_id = $1
      LIMIT 1
      `,
      [company_id]
    );

    if (existing.rows.length) {

      await pool.query(
        `
        UPDATE ${DB_SCHEMA}.company_ledger_mappings
        SET
          purchase_ledger = $1,
          invoice_parent_group = $2,
          cgst_ledger = $3,
          sgst_ledger = $4,
          igst_ledger = $5,
          tds_ledger = $6,
          cess_ledger = $7,
          rounded_off_ledger = $8,
          updated_at = NOW()
        WHERE company_id = $9
        `,
        [
          purchase_ledger || null,
          invoice_parent_group,
          cgst_ledger,
          sgst_ledger,
          igst_ledger,
          tds_ledger,
          cess_ledger,
          rounded_off_ledger,
          company_id
        ]
      );

      return res.status(200).json({
        status: "success",
        message: "Ledger mapping updated"
      });

    }

    await pool.query(
      `
      INSERT INTO ${DB_SCHEMA}.company_ledger_mappings
      (
        company_id,
        purchase_ledger,
        invoice_parent_group,
        cgst_ledger,
        sgst_ledger,
        igst_ledger,
        tds_ledger,
        cess_ledger,
        rounded_off_ledger
      )
      VALUES
      (
        $1,$2,$3,$4,$5,$6,$7,$8,$9
      )
      `,
      [
        company_id,
        purchase_ledger || null,
        invoice_parent_group,
        cgst_ledger,
        sgst_ledger,
        igst_ledger,
        tds_ledger,
        cess_ledger,
        rounded_off_ledger
      ]
    );

    return res.status(200).json({
      status: "success",
      message: "Ledger mapping saved"
    });

  } catch (err) {

    console.log(err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });

  }

});

/*
====================================
GET MAPPING
====================================
*/

router.get("/ledger-mapping/:companyId", async (req, res) => {

  try {

    const { companyId } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM ${DB_SCHEMA}.company_ledger_mappings
      WHERE company_id = $1
      LIMIT 1
      `,
      [companyId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        status: "error",
        message: "Mapping not found"
      });
    }

    return res.status(200).json({
      status: "success",
      data: result.rows[0]
    });

  } catch (err) {

    return res.status(500).json({
      status: "error",
      message: err.message
    });

  }

});

router.get("/purchase-ledgers/:companyId", async (req, res) => {
  try {
    const { companyId } = req.params;

    const mapping = await pool.query(
      `
      SELECT invoice_parent_group
      FROM ${DB_SCHEMA}.company_ledger_mappings
      WHERE company_id = $1
      LIMIT 1
      `,
      [companyId]
    );

    if (!mapping.rows.length) {
      return res.status(404).json({
        status: "error",
        message: "Purchase ledger mapping not found"
      });
    }

    const parentGroup = mapping.rows[0].invoice_parent_group;

    const result = await pool.query(
      `
      SELECT ledger_name
      FROM ${DB_SCHEMA}.all_ledger_details
      WHERE company_id = $1
        AND LOWER(TRIM(parent_group)) = LOWER(TRIM($2))
      ORDER BY ledger_name
      `,
      [companyId, parentGroup]
    );

    return res.status(200).json({
      status: "success",
      purchase_parent_group: parentGroup,
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error("Purchase ledgers error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;