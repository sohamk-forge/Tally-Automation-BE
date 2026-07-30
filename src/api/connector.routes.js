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

    const result = await pool.query(
      `
      SELECT
          company_name,
          from_year,
          to_year,
          tally_connected
      FROM ${DB_SCHEMA}.connector_machines
      WHERE user_id = $1
        AND tally_connected = true
      ORDER BY updated_at DESC
      LIMIT 1
      `,
      [user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "No connected machine found"
      });
    }

    return res.status(200).json({
      status: "success",
      data: result.rows[0]
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
        payload: job.payload,
        tally_url: process.env.TALLY_URL || "http://localhost:9000"
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

  try {
    const { userId } = req.connectorMachine;
    const { job_id: jobId, status, response_xml: responseXml, result } = req.body;

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

    await client.query("BEGIN");

    await processConnectorJobResult(client, {
      id: job.id,
      job_type: job.job_type,
      status,
      response_xml: responseXml || null,
      result: result || null,
      payload: job.payload
    });

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
      `,
      [
        status,
        responseXml || null,
        result || null,
        status === "failed" ? (result?.line_error || null) : null,
        jobId
      ]
    );

    await client.query("COMMIT");

    /* =========================================
       CHAIN OPENING STOCK (after COMMIT)
       A stock item does not exist in Tally until the connector has actually
       run its create job, so the successful create result is the only safe
       point to queue the opening-balance alteration.
       - Runs AFTER commit on purpose: Redis is not part of the transaction,
         so enqueueing inside it could leave an orphan job if we rolled back.
       - Uses `pool`, not `client`: the transaction is finished and the client
         is about to be released.
       - Conditions on the persisted row rather than the connector's reported
         status string, so a 'success'/'completed'/'SUCCESS' casing mismatch
         can't silently skip the chain.
       - The opening_quantity > 0 guard stops plain item creations from
         queueing a pointless alter that pushes zeros to Tally.
       - Wrapped in its own try/catch: the result is already committed, so a
         Redis hiccup must not turn a recorded result into a 500 and make the
         connector retry a job that already succeeded.
    ========================================= */

    if (job.job_type === "stock_item") {
      try {
        const stockItemId = job.payload?.stock_item_id;

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
            await alterStockItemQueue.add(
              "push-alter-stock-item",
              { stockItemId },
              {
                ...ALTER_STOCK_ITEM_JOB_OPTIONS,
                jobId: `${stockItemId}-${Date.now()}`
              }
            );

            console.log(`🔗 Opening stock chained for stock item ${stockItemId}`);
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
    await client.query("ROLLBACK");
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