import express from "express";
import pool from "../db/index.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import authMiddleware from "../middleware/auth.middleware.js";
import { claimPendingConnectorJobs } from "../services/connectorJobClaim.service.js";
import { processConnectorJobResult } from "../services/connectorJobResult.service.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* =========================================
   GENERATE CONNECTOR KEY (NEW)
========================================= */

router.post("/generate-key", verifySession(), async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

    const token = "PAIR-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const token = "PAIR-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `
      INSERT INTO app_test.connector_pairing_tokens
      (id, user_id, token, expires_at)
      VALUES (gen_random_uuid(), $1, $2, $3)
      `,
      [user_id, token, expiresAt]
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
   PAIR CONNECTOR
========================================= */

router.post("/pair", async (req, res) => {

  try {

    const {
      token,
      machine_id
    } = req.body;

    if (!token) {
      return res.status(400).json({
        status: "error",
        message: "token is required"
      });
    }

    if (!machine_id) {
      return res.status(400).json({
        status: "error",
        message: "machine_id is required"
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM app_test.connector_pairing_tokens
      WHERE token = $1
      LIMIT 1
      `,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Invalid token"
      });
    }

    const pairingToken = result.rows[0];

    if (pairingToken.is_used) {
      return res.status(400).json({
        status: "error",
        message: "Token already used"
      });
    }

    if (new Date(pairingToken.expires_at) < new Date()) {
      return res.status(400).json({
        status: "error",
        message: "Token expired"
      });
    }

    const userResult = await pool.query(
      `
      SELECT *
      FROM app_test.users
      WHERE id = $1
      LIMIT 1
      `,
      [pairingToken.user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    const user = userResult.rows[0];

    const jwtToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        machine_id
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "30d"
      }
    );

    const updateResult = await pool.query(
      `
      UPDATE app_test.connector_pairing_tokens
      SET
        is_used = TRUE,
        machine_id = $1
      WHERE id = $2
      RETURNING id
      `,
      [
        machine_id,
        pairingToken.id
      ]
    );

    if (updateResult.rows.length === 0) {
      return res.status(500).json({
        status: "error",
        message: "Failed to update pairing token"
      });
    }

    return res.status(200).json({
    return res.status(200).json({
      status: "success",
      message: "Connector paired successfully",
      jwt_token: jwtToken,
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
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }

});

/* =========================================
   CONNECTOR POLLS FOR JOBS
========================================= */

router.get("/jobs", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;

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
