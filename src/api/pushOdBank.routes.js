import express from "express";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";
import { safeEnqueueOdBank } from "../queues/odBank.queue.js";

const router = express.Router();

router.post(
  "/push-od-bank",
  verifySession(),
  async (req, res) => {
  try {
    const userId = await getLocalUserId(req.session.getUserId());

    if (!userId) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

    const {
      company_id,
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

    if (!company_id || !company?.trim()) {
      return res.status(400).json({
        error: "company_id and company are required"
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

    const companyId = Number(company_id);

    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Invalid company_id"
      });
    }

    console.log("========== PUSH OD/OC BANK ==========");
    console.log("Request userId:", userId);
    console.log("Request companyId:", companyId);
    console.log("Request company:", company);
    console.log("Ledger:", ledger_name);

    // =====================================================
    // GET EXACT COMPANY BY ID
    // =====================================================

    const companyResult = await pool.query(
      `
      SELECT
        id,
        name
      FROM app_test.companies
      WHERE id = $1
      LIMIT 1
      `,
      [companyId]
    );

    if (companyResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: `Company not found: ${companyId}`
      });
    }

    const companyRow = companyResult.rows[0];

    console.log("✅ COMPANY SELECTED:", {
      companyId: companyRow.id,
      companyName: companyRow.name,
      userId
    });

    console.log(`📝 Creating new OD/OC bank: ${bank_name}`);

    const insertResult = await pool.query(
      `
      INSERT INTO app_test.bank_od_accounts
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
        user_id,
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
        $20,
        $21,
        NOW(),
        NOW()
      )
      RETURNING id
      `,
      [
        companyId,
        companyRow.name,
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
        "pending",
        userId
      ]
    );

    const odBankId = insertResult.rows[0].id;
    console.log(`✅ OD/OC Bank created: ID ${odBankId}`);

    const { jobId } = await safeEnqueueOdBank(odBankId, userId);

    console.log(`📤 OD/OC Bank job queued: ${jobId}`);

    return res.status(200).json({
      status: "success",
      message: "OD/OC Bank queued for processing",
      jobId,
      odBankId,
      companyId
    });

  } catch (error) {
    console.error("Push OD/OC bank error:", error.message);
    return res.status(500).json({
      error: error.message
    });
  }
});

export default router;