import express from "express";
import pool from "../db/index.js";

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
      FROM app_test.company_ledger_mappings
      WHERE company_id = $1
      LIMIT 1
      `,
      [company_id]
    );

    if (existing.rows.length) {

      await pool.query(
        `
        UPDATE app_test.company_ledger_mappings
        SET
          invoice_parent_group = $1,
          cgst_ledger = $2,
          sgst_ledger = $3,
          igst_ledger = $4,
          tds_ledger = $5,
          cess_ledger = $6,
          rounded_off_ledger = $7,
          updated_at = NOW()
        WHERE company_id = $8
        `,
        [
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
      INSERT INTO app_test.company_ledger_mappings
      (
        company_id,
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
        $1,$2,$3,$4,$5,$6,$7,$8
      )
      `,
      [
        company_id,
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
      FROM app_test.company_ledger_mappings
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

export default router;