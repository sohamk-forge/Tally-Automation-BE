import express from "express";
import pool from "../db/index.js";
import authMiddleware from "../middleware/auth.middleware.js";
import { checkCompanyAccess } from "../utils/companyAccess.js";
import { odBankQueue, OD_BANK_JOB_OPTIONS, getOdBankJobId } from "../queues/odbank.queue.js";

const router = express.Router();

router.post("/push-od-bank", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      company,
      ledger_name,
      account_type,
      opening_balance,
      od_limit,
      bank_name,
      branch_name,
      account_holder,
      account_number,
      ifsc_code,
      swift_code,
      address,
      state,
      country,
      pincode,
      contact_person,
      mobile,
      email
    } = req.body;

    if (!company?.trim()) {
      return res.status(400).json({
        error: "Company is required"
      });
    }

    if (!ledger_name?.trim()) {
      return res.status(400).json({
        error: "Ledger name is required"
      });
    }

    if (!account_type?.trim()) {
      return res.status(400).json({
        error: "Account type is required"
      });
    }

    console.log(`🔍 Looking up company: ${company.trim()}`);

    const companyResult = await pool.query(
      `SELECT id FROM app_test.companies
       WHERE name = $1 LIMIT 1`,
      [company.trim()]
    );

    if (!companyResult.rows.length) {
      return res.status(400).json({
        status: "error",
        message: `Company not found: ${company.trim()}`
      });
    }

    const companyId = companyResult.rows[0].id;
    console.log(`✅ Company found: ID ${companyId}`);

    const hasAccess = await checkCompanyAccess(userId, companyId);
    if (!hasAccess) {
      return res.status(403).json({
        status: "error",
        message: "You don't have access to this company"
      });
    }

    console.log(`✅ User ${userId} has access to company ${companyId}`);

    console.log(`📝 Creating new OD/OC bank: ${bank_name}`);

    const insertResult = await pool.query(
      `INSERT INTO app_test.bank_od_accounts
       (
         company_id,
         company_name,
         ledger_name,
         account_type,
         opening_balance,
         od_limit,
         bank_name,
         branch_name,
         account_holder,
         account_number,
         ifsc_code,
         swift_code,
         address,
         state,
         country,
         pincode,
         contact_person,
         mobile,
         email,
         sync_status,
         created_at,
         updated_at
       )
       VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW(), NOW())
       RETURNING id`,
      [
        companyId,
        company?.trim(),
        ledger_name?.trim(),
        account_type?.trim(),
        opening_balance || 0,
        od_limit || 0,
        bank_name || "",
        branch_name || "",
        account_holder || "",
        account_number || "",
        ifsc_code || "",
        swift_code || "",
        address || "",
        state || "",
        country || "India",
        pincode || "",
        contact_person || "",
        mobile || "",
        email || "",
        "pending"
      ]
    );

    const odBankId = insertResult.rows[0].id;
    console.log(`✅ OD/OC Bank created: ID ${odBankId}`);

    const job = await odBankQueue.add(
      "push-od-bank",
      {
        odBankId,
        userId
      },
      {
        ...OD_BANK_JOB_OPTIONS,
        jobId: getOdBankJobId(odBankId)
      }
    );

    console.log(`📤 OD/OC Bank job queued: ${job.id}`);

    return res.status(200).json({
      status: "success",
      message: "OD/OC Bank queued for processing",
      jobId: job.id,
      odBankId,
      companyId
    });

  } catch (error) {
    console.error("❌ Push OD/OC bank error:", error.message);
    return res.status(500).json({
      error: error.message
    });
  }
});

export default router;