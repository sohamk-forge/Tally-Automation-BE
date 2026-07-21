import express from "express";
import pool from "../db/index.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import authMiddleware from "../middleware/auth.middleware.js";
import { claimPendingConnectorJobs } from "../services/connectorJobClaim.service.js";
import { processConnectorJobResult } from "../services/connectorJobResult.service.js";
import {
  syncQueue,
  getSyncJobId,
  SYNC_JOB_OPTIONS
} from "../queues/sync.queue.js";

const router = express.Router();

/* =========================================
   GENERATE CONNECTOR KEY
========================================= */

router.post("/generate-key", async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({
        status: "error",
        message: "user_id is required"
      });
    }

    const token = "PAIR-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `
      INSERT INTO app_test.connector_pairing_tokens
      (id, user_id, token, expires_at)
      VALUES (gen_random_uuid(), $1, $2, $3)
      `,
      [user_id, token, expiresAt]
    );

    return res.status(200).json({
      status: "success",
      token,
      expires_at: expiresAt
    });

  } catch (err) {
    console.error("Generate Key Error:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

/* =========================================
   PAIR CONNECTOR + AUTO SYNC ✅
========================================= */

router.post("/pair", async (req, res) => {

  try {

    const {
      token,
      company,    // ✅ company name
      fromYear,   // ✅ from year e.g. "2026"
      toYear      // ✅ to year e.g. "2027"
    } = req.body;

    // Validate
    if (!token) {
      return res.status(400).json({ status: "error", message: "token is required" });
    }

    if (!company?.trim()) {
      return res.status(400).json({ status: "error", message: "company is required" });
    }

    if (!fromYear || !toYear) {
      return res.status(400).json({ status: "error", message: "fromYear and toYear are required" });
    }

    // Validate token
    const result = await pool.query(
      `SELECT * FROM app_test.connector_pairing_tokens WHERE token = $1 LIMIT 1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "Invalid token" });
    }

    const pairingToken = result.rows[0];

    if (pairingToken.is_used) {
      return res.status(400).json({ status: "error", message: "Token already used" });
    }

    if (new Date(pairingToken.expires_at) < new Date()) {
      return res.status(400).json({ status: "error", message: "Token expired" });
    }

    // Fetch user
    const userResult = await pool.query(
      `SELECT * FROM app_test.users WHERE id = $1 LIMIT 1`,
      [pairingToken.user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "User not found" });
    }

    const user = userResult.rows[0];

    // ✅ Lookup company_id (company already exists - synced from Tally)
    const companyResult = await pool.query(
      `SELECT id FROM app_test.companies WHERE TRIM(name) = TRIM($1) LIMIT 1`,
      [company.trim()]
    );

    const companyId = companyResult.rows[0]?.id || null;

    if (!companyId) {
      return res.status(400).json({
        status: "error",
        message: `Company not found: ${company}`
      });
    }

    console.log(`✅ Company: ${company} → ID ${companyId}`);

    // Generate JWT
    const jwtToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    // ✅ Mark token as used + save company_id
    const updateResult = await pool.query(
      `
      UPDATE app_test.connector_pairing_tokens
      SET
        is_used = TRUE,
        company_id = $1
      WHERE id = $2
      RETURNING id
      `,
      [companyId, pairingToken.id]
    );

    if (updateResult.rows.length === 0) {
      return res.status(500).json({ status: "error", message: "Failed to update pairing token" });
    }

    // ✅ AUTO-TRIGGER SYNC!
    let syncJobId = null;
    try {
      const jobLogResult = await pool.query(
        `
        INSERT INTO app_test.job_logs (job_type, status, payload)
        VALUES ($1, $2, $3)
        RETURNING id
        `,
        [
          "auto_sync",
          "pending",
          JSON.stringify({
            company: company.trim(),
            fromYear,
            toYear
          })
        ]
      );

      const jobLogId = jobLogResult.rows[0].id;
      syncJobId = jobLogId;

      await syncQueue.add(
        "auto-sync",
        {
          jobLogId,
          company: company.trim(),
          fromYear,
          toYear
        },
        {
          ...SYNC_JOB_OPTIONS,
          jobId: getSyncJobId(jobLogId)
        }
      );

      console.log(`✅ Auto sync triggered: ${company} (${fromYear}-${toYear})`);

    } catch (syncErr) {
      console.error(`⚠️ Auto sync trigger failed: ${syncErr.message}`);
    }

    return res.status(200).json({
      status: "success",
      message: "Connector paired successfully. Sync started!",
      jwt_token: jwtToken,
      company_id: companyId,
      sync_started: true,
      sync_job_id: syncJobId,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name
      }
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "error", message: err.message });
  }

});

/* =========================================
   CONNECTOR POLLS FOR JOBS
========================================= */

router.get("/jobs", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    console.log("================================");
console.log("JWT User:", req.user);
console.log("User ID:", userId);
console.log("================================");

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User ID not found in token"
      });
    }

    console.log(`🔍 Connector polling for jobs: user_id=${userId}`);

    const jobs = await claimPendingConnectorJobs({ userId });

    const formattedJobs = jobs.map(job => ({
      id: job.id,
      job_type: job.job_type,
      request_xml: job.request_xml,
      payload: job.payload,
      tally_url: process.env.TALLY_URL || "http://localhost:9000"
    }));

    console.log(`✅ Returned ${formattedJobs.length} jobs to connector`);

    res.json({
      status: "success",
      data: formattedJobs
    });

  } catch (err) {
    console.error("❌ GET /api/connector/jobs ERROR:", err.message);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

/* =========================================
   CONNECTOR SUBMITS JOB RESULT
========================================= */

router.post("/jobs/result", authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    const { job_id, status, response_xml, result } = req.body;

    if (!job_id || !status) {
      return res.status(400).json({
        status: "error",
        message: "job_id and status are required"
      });
    }

    console.log(`📥 Job result: job_id=${job_id}, status=${status}`);

    await client.query("BEGIN");

    const jobResult = await client.query(
      `
      UPDATE app_test.connector_jobs
      SET
        status = $1,
        response_xml = $2,
        result = $3,
        updated_at = NOW()
      WHERE id = $4
      RETURNING *
      `,
      [status, response_xml || null, result ? JSON.stringify(result) : null, job_id]
    );

    const job = jobResult.rows[0];

    if (!job) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        status: "error",
        message: `Job ${job_id} not found`
      });
    }

    await processConnectorJobResult(client, {
      id: job.id,
      job_type: job.job_type,
      status: status,
      response_xml: response_xml,
      result: result,
      payload: job.payload
    });

    await client.query("COMMIT");

    console.log(`✅ Job result processed: job_id=${job_id}`);

    res.json({
      status: "success",
      message: `Job ${job_id} processed`,
      jobId: job_id
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Job result error:", err.message);
    res.status(500).json({
      status: "error",
      message: err.message
    });

  } finally {
    client.release();
  }
});

export default router;