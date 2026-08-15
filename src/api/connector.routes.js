import express from "express";
import crypto from "crypto";
import pool from "../db/index.js";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";
import { verifyConnectorApiKey } from "../middleware/apiKey.middleware.js";
import { claimPendingConnectorJobs } from "../services/connectorJobClaim.service.js";
import { processConnectorJobResult } from "../services/connectorJobResult.service.js";
import {
  alterStockItemQueue,
  ALTER_STOCK_ITEM_JOB_OPTIONS
} from "../queues/alterStockItem.queue.js";

import { DB_SCHEMA } from "../config/db.js";
const router = express.Router();

/* =========================================
   GENERATE CONNECTOR KEY
   Initiated by a logged-in dashboard user, so this requires a real
   SuperTokens session — user_id is derived from it, not the request body.
========================================= */

router.post("/generate-key", verifySession(), async (req, res) => {
  try {

    const user_id = await getLocalUserId(req.session.getUserId());

    if (!user_id) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

    const token = "PAIR-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `
      INSERT INTO ${DB_SCHEMA}.connector_pairing_tokens
      (
        id,
        user_id,
        token,
        expires_at
      )
      VALUES
      (
        gen_random_uuid(),
        $1,
        $2,
        $3
      )
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

router.get("/current", verifySession(), async (req, res) => {
  try {
    const user_id = await getLocalUserId(req.session.getUserId());

    if (!user_id) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

    // Live status comes from connector_api_keys.last_seen_at.
    // Machine table is used only for display/company information.
    const result = await pool.query(
      `
      SELECT
          k.machine_id,
          k.last_seen_at,
          m.company_name,
          m.from_year,
          m.to_year
      FROM ${DB_SCHEMA}.connector_api_keys k
      LEFT JOIN ${DB_SCHEMA}.connector_machines m
        ON m.machine_id = k.machine_id
       AND m.user_id = k.user_id
      WHERE k.user_id = $1
        AND k.revoked_at IS NULL
        AND k.last_seen_at >= NOW() - INTERVAL '30 seconds'
      ORDER BY k.last_seen_at DESC
      LIMIT 1
      `,
      [user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Connector is offline"
      });
    }

    return res.status(200).json({
      status: "success",
      data: {
        connected: true,
        machine_id: result.rows[0].machine_id,
        last_seen_at: result.rows[0].last_seen_at,
        company_name: result.rows[0].company_name,
        from_year: result.rows[0].from_year,
        to_year: result.rows[0].to_year
      }
    });

  } catch (err) {
    console.error("Current Connector Error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});
/* =========================================
   LIST GENERATED API KEYS
   Dashboard-only view of this user's connector API keys. There's no
   separate "name" for a key — it's shown by the machine it belongs to
   (there's a 1:1 relationship between a paired machine and its key).
========================================= */

router.get("/api-keys", verifySession(), async (req, res) => {
  try {
    const user_id = await getLocalUserId(req.session.getUserId());

    if (!user_id) {
      return res.status(404).json({
        status: "error",
        message: "No profile found for this account"
      });
    }

    const result = await pool.query(
      `
      SELECT
          cak.id,
          cak.machine_id,
          cm.machine_name,
          cm.company_name,
          cak.created_at,
          cak.revoked_at
      FROM ${DB_SCHEMA}.connector_api_keys cak
      LEFT JOIN ${DB_SCHEMA}.connector_machines cm
        ON cm.machine_id = cak.machine_id
      WHERE cak.user_id = $1
      ORDER BY cak.created_at DESC
      `,
      [user_id]
    );

    return res.status(200).json({
      status: "success",
      data: result.rows.map((row) => ({
        id: row.id,
        keyName: row.machine_name || row.machine_id,
        company: row.company_name || "—",
        status: row.revoked_at ? "Revoked" : "Active",
        createdAt: row.created_at
      }))
    });

  } catch (err) {

    console.error("List API Keys Error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });

  }
});

/* =========================================
   CONNECTOR JOB POLLING (API-key auth)
   The connector polls for pending work and submits results back.
========================================= */

router.get("/jobs", verifyConnectorApiKey, async (req, res) => {
  try {
    const { userId } = req.connectorMachine;

    const jobs = await claimPendingConnectorJobs({ userId });

    return res.status(200).json({
      status: "success",
      data: jobs.map((job) => ({
        id: job.id,
        job_type: job.job_type,
        request_xml: job.request_xml,
        payload: job.payload
      }))
    });

  } catch (err) {
    console.error("Claim Connector Jobs Error:", err);
    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

router.post("/jobs/result", verifyConnectorApiKey, async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const { userId } = req.connectorMachine;
    const {
      job_id: jobId,
      status,
      response_xml: responseXml,
      result
    } = req.body;

    if (!jobId || !status) {
      client.release();

      return res.status(400).json({
        status: "error",
        message: "jobId and status are required"
      });
    }

    const jobResult = await client.query(
      `
      SELECT *
      FROM ${DB_SCHEMA}.connector_jobs
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
      `,
      [jobId, userId]
    );

    const job = jobResult.rows[0];

    if (!job) {
      client.release();

      return res.status(404).json({
        status: "error",
        message: "Job not found"
      });
    }

    // =========================================
    // RECORD CONNECTOR RESULT
    // =========================================

    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      `
      UPDATE ${DB_SCHEMA}.connector_jobs
      SET
        status = $1,
        response_xml = $2,
        result = $3,
        error_message = $4,
        completed_at = NOW(),
        updated_at = NOW()
      WHERE id = $5
        AND user_id = $6
      `,
      [
        status,
        responseXml || null,
        result || null,
        status === "failed"
          ? (result?.line_error || null)
          : null,
        jobId,
        userId
      ]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    // =========================================
    // BUSINESS PROCESSING
    // =========================================

    if (job.job_type !== "sync") {
      try {
        await processConnectorJobResult(pool, {
          id: job.id,
          job_type: job.job_type,
          status,
          response_xml: responseXml || null,
          result: result || null,
          payload: job.payload
        });
      } catch (processingError) {
        console.error(
          `⚠️ Business processing failed for connector job ${jobId}:`,
          processingError.message
        );
      }
    }

    // =========================================
    // STOCK ITEM CHAIN
    // =========================================

   if (job.job_type === "stock_item") {
  try {
    const stockItemId = job.payload?.stock_item_id;
    const requestedByUserId = job.payload?.requested_by_user_id;

    if (stockItemId) {
      const { rows } = await pool.query(
        `
        SELECT opening_quantity
        FROM ${DB_SCHEMA}.push_stock_item
        WHERE id = $1
          AND status = 'success'
        `,
        [stockItemId]
      );

      if (Number(rows[0]?.opening_quantity) > 0) {

        if (!requestedByUserId) {
          console.error(
            `⚠️ Cannot chain opening stock for item ${stockItemId} — original job payload missing requested_by_user_id`
          );
        } else {
          await alterStockItemQueue.add(
            "push-alter-stock-item",
            {
              stockItemId,
              userId: requestedByUserId
            },
            {
              ...ALTER_STOCK_ITEM_JOB_OPTIONS,
              jobId: `${stockItemId}-${Date.now()}`
            }
          );

          console.log(
            `🔗 Opening stock chained for stock item ${stockItemId} (User: ${requestedByUserId})`
          );
        }
      }
    }
  } catch (chainError) {
    console.error(
      `⚠️ Failed to chain opening stock for job ${jobId}:`,
      chainError.message
    );
  }
}

    return res.status(200).json({
      status: "success",
      message: "Job result recorded"
    });

  } catch (err) {

    if (transactionStarted) {
      await client.query("ROLLBACK");
    }

    console.error("Connector Job Result Error:", err);

    return res.status(500).json({
      status: "error",
      message: err.message
    });

  } finally {
    client.release();
  }
});

export default router;