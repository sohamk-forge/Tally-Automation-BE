import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";

const router = express.Router();

router.post("/ledger-mapping", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      company_id,
      purchase_ledger,
      invoice_parent_group,
      cgst_ledger,
      sgst_ledger,
      igst_ledger,
      tds_ledger,
      cess_ledger,
      rounded_off_ledger
    } = req.body;

    const companyId = validateCompanyId(company_id);
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

    const existing = await pool.query(
      `SELECT id FROM app_test.company_ledger_mappings
       WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );

    if (existing.rows.length) {
      await pool.query(
        `UPDATE app_test.company_ledger_mappings
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
         WHERE company_id = $9`,
        [
          purchase_ledger || null,
          invoice_parent_group,
          cgst_ledger,
          sgst_ledger,
          igst_ledger,
          tds_ledger,
          cess_ledger,
          rounded_off_ledger,
          companyId
        ]
      );

      return res.status(200).json({
        status: "success",
        message: "Ledger mapping updated",
        company_id: companyId
      });
    }

    await pool.query(
      `INSERT INTO app_test.company_ledger_mappings
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        companyId,
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
      message: "Ledger mapping saved",
      company_id: companyId
    });

  } catch (err) {
    console.error("❌ Ledger mapping POST error:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

router.get("/ledger-mapping/:companyId", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = validateCompanyId(req.params.companyId);

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
      `SELECT *
       FROM app_test.company_ledger_mappings
       WHERE company_id = $1 LIMIT 1`,
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
      company_id: companyId,
      data: result.rows[0]
    });

  } catch (err) {
    console.error("❌ Ledger mapping GET error:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;