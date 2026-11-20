import express from "express";
import crypto from "crypto";
import pool from "../db/index.js";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { getLocalUserId } from "../utils/getLocalUserId.js";
import { verifyConnectorApiKey } from "../middleware/apiKey.middleware.js";
import { claimPendingConnectorJobs, extendConnectorJobLeases } from "../services/connectorJobClaim.service.js";
import { processConnectorJobResult } from "../services/connectorJobResult.service.js";
import { resolveTallyOwner, findLiveConnectorKey, getTallyStatusForKey, getCompanyOpenState, CONNECTOR_ONLINE_WINDOW } from "../services/connectorOwner.service.js";
import { safeEnqueueAlterStockItem } from "../queues/alterStockItem.queue.js";
import { safeEnqueueSalesPrint } from "../queues/salesPrint.queue.js";
import { confirmBankVoucherInTally } from "../services/bankVoucherConfirm.service.js";
import { safeEnqueuePostInvoiceRefresh } from "../queues/postInvoiceRefresh.queue.js";

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

    // Optional company scope. "connected" is machine-level: one Tally machine serves all of the
    // owner's companies, so every company shows the connector as live while it is online (before,
    // only the company the key was last paired/synced for did). Which company is actually open in
    // TallyPrime is reported separately as company_open. The push gate (resolveConnectorForCompany)
    // is unchanged and still requires a key paired to the company.
    const scopedCompanyId = Number(req.query.company_id);
    if (scopedCompanyId) {
      const owner = await resolveTallyOwner(scopedCompanyId, user_id);
      const live = await findLiveConnectorKey(owner.ownerUserId);
      if (!live) {
        return res.status(404).json({
          status: "error",
          message: "Connector is offline"
        });
      }
      const tallyStatus = await getTallyStatusForKey(live.api_key_id);

      // Is the company selected on the website the one open in TallyPrime? null = cannot tell.
      const companyOpen = await getCompanyOpenState(scopedCompanyId, tallyStatus);

      return res.status(200).json({
        status: "success",
        data: {
          connected: true,
          machine_id: live.machine_id,
          last_seen_at: live.last_seen_at,
          ...tallyStatus,
          company_open: companyOpen
        }
      });
    }

    // Live status comes from connector_api_keys.last_seen_at.
    // Machine table is used only for display/company information.
    const result = await pool.query(
      `
      SELECT
          k.id AS api_key_id,
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
        AND k.last_seen_at >= NOW() - INTERVAL '${CONNECTOR_ONLINE_WINDOW}'
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
        ...(await getTallyStatusForKey(result.rows[0].api_key_id)),
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

// The connector's 1-second heartbeat. verifyConnectorApiKey does all the work: it saves last_seen_at and
// the Tally up/down report that comes in the headers. Kept separate from /jobs because the connector
// pauses job polling while it is busy with a slow Tally job, but must still be seen as alive.
router.post("/ping", verifyConnectorApiKey, async (req, res) => {
  // A live heartbeat keeps its claimed jobs' leases alive (long Tally imports).
  try {
    await extendConnectorJobLeases({ userId: req.connectorMachine.userId });
  } catch (err) {
    console.error("extendConnectorJobLeases failed:", err.message);
  }
  res.status(200).json({ status: "ok" });
});

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
      return res.status(404).json({
        status: "error",
        message: "Job not found"
      });
    }

    // Idempotency: a replayed result must not overwrite a job (and its
    // invoice) that already finished successfully. A 'failed' job may
    // still receive a late result — e.g. it was marked timed-out by a
    // sweep but the connector did eventually push it to Tally.
    if (["completed", "success"].includes(job.status)) {
      return res.status(200).json({
        status: "success",
        message: "Job result already recorded"
      });
    }

    const errorMessage =
      status === "failed"
        // line_error: Tally rejected an XML import (request reached
        // Tally fine, Tally itself refused a line). error: the
        // connector never got a usable response at all — Tally
        // unreachable, network failure, timeout, etc. Prefer
        // line_error when both are somehow present since it's the
        // more specific, Tally-sourced reason.
        ? (result?.line_error || result?.error || null)
        : null;

    // =========================================
    // RECORD CONNECTOR RESULT + BUSINESS PROCESSING
    // One transaction: if updating the business record (e.g. the invoice's
    // sync_status) fails, the job result rolls back and the connector gets
    // a 500, so it retries instead of leaving the invoice 'pending' forever
    // behind a job that looks completed.
    // =========================================

    await client.query("BEGIN");
    transactionStarted = true;

    // The status guard makes concurrent replays of the same result safe: only
    // the first one to reach here updates the job and its business record.
    const updateResult = await client.query(
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
        AND status NOT IN ('completed', 'success')
      `,
      [
        status,
        responseXml || null,
        result || null,
        errorMessage,
        jobId,
        userId
      ]
    );

    if (updateResult.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(200).json({
        status: "success",
        message: "Job result already recorded"
      });
    }

    if (job.job_type !== "sync") {
      await processConnectorJobResult(client, {
        id: job.id,
        job_type: job.job_type,
        status,
        response_xml: responseXml || null,
        result: result || null,
        error_message: errorMessage,
        payload: job.payload
      });
    }

    await client.query("COMMIT");
    transactionStarted = false;

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
          await pool.query(
            `
            UPDATE ${DB_SCHEMA}.push_stock_item
            SET status = 'pending', user_id = $1, pending_job_type = 'alter', updated_at = NOW()
            WHERE id = $2
            `,
            [requestedByUserId, stockItemId]
          );

          await safeEnqueueAlterStockItem(stockItemId, requestedByUserId);

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

    // =========================================
    // SALES PRINT CHAIN
    // Manual Create Sales Invoice only: connectorJobResult flagged the row
    // print_status = 'fetching' (and committed it) when print was requested.
    // =========================================
    if (job.job_type === "sales_invoice" && job.payload?.invoice_id) {
      try {
        const { rows } = await pool.query(
          `
          SELECT id FROM ${DB_SCHEMA}.sales_invoice_extractions
          WHERE id = $1 AND print_requested = TRUE AND print_status = 'fetching'
          `,
          [job.payload.invoice_id]
        );
        if (rows.length > 0) {
          await safeEnqueueSalesPrint(rows[0].id);
        }
      } catch (chainError) {
        console.error(
          `⚠️ Failed to chain sales print for job ${jobId}:`,
          chainError.message
        );
      }
    }

    // =========================================
    // POST-INVOICE REFRESH
    // A sales / purchase voucher is now in Tally: read it back and move the
    // ledger / group balances so every page reflects it. The worker re-checks
    // sync_status, so a failed push is skipped there.
    // =========================================
    if (
      (job.job_type === "sales_invoice" || job.job_type === "purchase_invoice") &&
      job.payload?.invoice_id
    ) {
      try {
        await safeEnqueuePostInvoiceRefresh(
          job.job_type === "sales_invoice" ? "sales" : "purchase",
          job.payload.invoice_id
        );
      } catch (chainError) {
        console.error(
          `⚠️ Failed to queue post-invoice refresh for job ${jobId}:`,
          chainError.message
        );
      }
    }

    // =========================================
    // BANK VOUCHER CONFIRMATION
    // Read the voucher back from Tally for its number; only then is it
    // SUCCESS. Rows still PENDING_CONNECTOR after the result commit are the
    // ones Tally accepted. Fire-and-forget: the connector must not wait.
    // =========================================
    if (job.job_type === "voucher") {
      const voucherIds = Array.isArray(job.payload?.voucher_ids)
        ? job.payload.voucher_ids
        : [job.payload?.voucher_id];
      const ids = voucherIds.map(Number).filter(Number.isInteger);
      if (ids.length) {
        confirmBankVoucherInTally(ids).catch(async (confirmError) => {
          console.error(`⚠️ Bank voucher confirmation crashed for job ${jobId}:`, confirmError.message);
          await pool.query(
            `UPDATE ${DB_SCHEMA}.contra_vouchers
             SET status = 'FAILED', err_message = $1, updated_at = NOW()
             WHERE id = ANY($2::int[]) AND status = 'PENDING_CONNECTOR'`,
            [`Could not confirm the voucher in Tally: ${confirmError.message}. Check Tally, then re-push.`, ids]
          ).catch(() => {});
        });
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