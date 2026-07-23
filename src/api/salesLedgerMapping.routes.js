import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess, validateCompanyId } from "../utils/companyAccess.js";

const router = express.Router();

router.post("/sales-ledger-mapping", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      company_id,
      sales_parent_group,
      sales_ledger,
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
        message: "Valid company_id required"
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
      `SELECT id FROM app_test.company_sales_ledger_mappings
       WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );

    if (existing.rows.length) {
      await pool.query(
        `UPDATE app_test.company_sales_ledger_mappings
         SET
           sales_parent_group = $1,
           sales_ledger = $2,
           cgst_ledger = $3,
           sgst_ledger = $4,
           igst_ledger = $5,
           tds_ledger = $6,
           cess_ledger = $7,
           rounded_off_ledger = $8,
           updated_at = NOW()
         WHERE company_id = $9`,
        [
          sales_parent_group,
          sales_ledger,
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
        message: "Sales ledger mapping updated",
        company_id: companyId
      });
    }

    await pool.query(
      `INSERT INTO app_test.company_sales_ledger_mappings
       (
         company_id,
         sales_parent_group,
         sales_ledger,
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
        sales_parent_group,
        sales_ledger,
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
      message: "Sales ledger mapping saved",
      company_id: companyId
    });

  } catch (err) {
    console.error("❌ SALES LEDGER MAPPING POST ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

router.get("/sales-ledger-mapping/:companyId", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = validateCompanyId(req.params.companyId);

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: "Valid company_id required"
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
      `SELECT * FROM app_test.company_sales_ledger_mappings
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
    console.error("❌ SALES LEDGER MAPPING GET ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

router.get("/sales-ledgers/:companyId", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = validateCompanyId(req.params.companyId);

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: "Valid company_id required"
      });
    }

    const hasAccess = await checkCompanyAccess(userId, companyId);
    if (!hasAccess) {
      return res.status(403).json({
        status: "error",
        message: "You don't have access to this company"
      });
    }

    const mapping = await pool.query(
      `SELECT sales_parent_group FROM app_test.company_sales_ledger_mappings
       WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );

    if (!mapping.rows.length) {
      return res.status(404).json({
        status: "error",
        message: "Sales ledger mapping not found"
      });
    }

    const parentGroup = mapping.rows[0].sales_parent_group;

    const result = await pool.query(
      `SELECT ledger_name
       FROM app_test.all_ledger_details
       WHERE company_id = $1
         AND LOWER(TRIM(parent_group)) = LOWER(TRIM($2))
       ORDER BY ledger_name`,
      [companyId, parentGroup]
    );

    return res.status(200).json({
      status: "success",
      company_id: companyId,
      sales_parent_group: parentGroup,
      count: result.rows.length,
      data: result.rows
    });

  } catch (err) {
    console.error("❌ SALES LEDGERS GET ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

router.patch("/sales-ledger/:companyId", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = validateCompanyId(req.params.companyId);
    const { sales_ledger } = req.body;

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: "Valid company_id required"
      });
    }

    const hasAccess = await checkCompanyAccess(userId, companyId);
    if (!hasAccess) {
      return res.status(403).json({
        status: "error",
        message: "You don't have access to this company"
      });
    }

    if (!sales_ledger) {
      return res.status(400).json({
        status: "error",
        message: "sales_ledger required"
      });
    }

    await pool.query(
      `UPDATE app_test.company_sales_ledger_mappings
       SET
         sales_ledger = $1,
         updated_at = NOW()
       WHERE company_id = $2`,
      [sales_ledger, companyId]
    );

    return res.json({
      status: "success",
      message: "Sales ledger updated successfully",
      company_id: companyId
    });

  } catch (err) {
    console.error("❌ SALES LEDGER PATCH ERROR:", err.message);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

export default router;