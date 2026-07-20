import express from "express";
import pool from "../db/index.js";
import {
  bankQueue,
  BANK_JOB_OPTIONS,
  getBankJobId
} from "../queues/bank.queue.js";

const router = express.Router();

router.post("/push-bank", async (req, res) => {
  try {
    const {
      company,
      ledger_name,
      parent,
      opening_balance,
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

    // ─────────────────────────────────────────────────────────────
    // STEP 1: VALIDATE REQUIRED FIELDS
    // ─────────────────────────────────────────────────────────────

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

    // ─────────────────────────────────────────────────────────────
    // STEP 2: GET COMPANY ID ✅ (NEW!)
    // ─────────────────────────────────────────────────────────────

    console.log(`🔍 Looking up company: ${company.trim()}`);

    const companyResult = await pool.query(
      `
      SELECT id
      FROM app_test.companies
      WHERE name = $1
      LIMIT 1
      `,
      [company.trim()]
    );

    if (companyResult.rows.length === 0) {
      return res.status(400).json({
        status: "error",
        message: `Company not found: ${company.trim()}`
      });
    }

    const companyId = companyResult.rows[0].id;
    console.log(`✅ Company found: ID ${companyId}`);

    // ─────────────────────────────────────────────────────────────
    // STEP 3: INSERT BANK WITH COMPANY_ID ✅ (FIXED!)
    // ─────────────────────────────────────────────────────────────

    console.log(`📝 Creating new bank: ${bank_name}`);

    const insertResult = await pool.query(
      `
      INSERT INTO app_test.push_bank
      (
        company_id,
        company_name,
        ledger_name,
        parent_group,
        opening_balance,
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
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19,
        NOW(),
        NOW()
      )
      RETURNING id
      `,
      [
        companyId,                    // $1
        company?.trim(),              // $2
        ledger_name?.trim(),          // $3
        parent || "Bank Accounts",    // $4
        opening_balance || 0,         // $5
        bank_name || "",              // $6
        branch_name || "",            // $7
        account_holder || "",         // $8
        account_number || "",         // $9
        ifsc_code || "",              // $10
        swift_code || "",             // $11
        address || "",                // $12
        state || "",                  // $13
        country || "India",           // $14
        pincode || "",                // $15
        contact_person || "",         // $16
        mobile || "",                 // $17
        email || "",                  // $18
        "pending"                     // $19
      ]
    );

    const bankId = insertResult.rows[0].id;
    console.log(`✅ Bank created: ID ${bankId}`);

    // ─────────────────────────────────────────────────────────────
    // STEP 4: QUEUE THE JOB
    // ─────────────────────────────────────────────────────────────

    const job = await bankQueue.add(
      "push-bank",
      { bankId },
      {
        ...BANK_JOB_OPTIONS,
        jobId: getBankJobId(bankId)
      }
    );

    console.log(`📤 Bank job queued: ${job.id}`);

    return res.status(200).json({
      status: "success",
      message: "Bank queued for processing",
      jobId: job.id,
      bankId,
      companyId
    });

  } catch (error) {
    console.error("Push bank error:", error.message);
    return res.status(500).json({
      error: error.message
    });
  }
});

export default router;