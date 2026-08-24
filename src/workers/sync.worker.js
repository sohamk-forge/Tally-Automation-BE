import { Worker } from "bullmq";
import IORedis from "ioredis";
import axios from "axios";

import pool from "../db/index.js";
import { SYNC_QUEUE_NAME, safeEnqueueSync } from "../queues/sync.queue.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

/* ===================================================
  AXIOS CLIENT
  Only shared, non-user-specific config lives here.
  "x-user-id" is deliberately NOT set here — this client
  is a module-level singleton reused across every job the
  worker processes. Baking a specific userId into its
  default headers would leak the first job's user into
  every subsequent job's requests (the same class of bug
  this whole fix chain has been chasing). Each request
  below sets "x-user-id" explicitly, per call, from that
  job's own job.data.userId.
=================================================== */

const api = axios.create({
  baseURL: process.env.BASE_URL || "http://localhost:5000",
  timeout: 300000,
  headers: {
    "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET
  }
});

/* ===================================================
  DATE HELPERS
  fromYear/toYear come in as plain years (e.g. "2026",
  "2027") from job.data — Tally's voucher-sync route
  expects full YYYYMMDD dates, financial-year style
  (1 Apr fromYear → 31 Mar toYear).
=================================================== */

function financialYearDates(fromYear, toYear) {
  const fromDate = `${fromYear}0401`;
  const toDate = `${toYear}0331`;
  return { fromDate, toDate };
}

/* ===================================================
  JOB LOG STATUS HELPERS
=================================================== */

async function markJobRunning(jobLogId) {
  await pool.query(
    `
    UPDATE app_test.job_logs
    SET status = 'running', started_at = NOW()
    WHERE id = $1
    `,
    [jobLogId]
  );
}

// results is the per-step [{step, status, durationMs, summary|error}] array
// from every runSyncStep() call. The overall job is still "completed" even
// when individual steps failed (see the comment at the call site for why),
// but until now that per-step detail only ever went to console output —
// invisible to anyone not tailing server logs at the exact moment it ran.
// error_message gets a short human-readable summary (only set when at
// least one step failed); raw_response gets the full step-by-step JSON for
// drill-down. raw_response is otherwise unused by any active code path
// (its only other reader/writer, connectorJob.routes.js, isn't mounted).
async function markJobCompleted(jobLogId, results = []) {
  const failedSteps = results.filter((r) => r.status === "failed");

  const errorMessage = failedSteps.length > 0
    ? `${failedSteps.length}/${results.length} steps failed: ${failedSteps.map((r) => `${r.step} (${r.error})`).join("; ")}`
    : null;

  await pool.query(
    `
    UPDATE app_test.job_logs
    SET status = 'completed', completed_at = NOW(), error_message = $2, raw_response = $3
    WHERE id = $1
    `,
    [jobLogId, errorMessage, JSON.stringify(results)]
  );
}

async function markJobFailed(jobLogId, errorMessage) {
  await pool.query(
    `
    UPDATE app_test.job_logs
    SET status = 'failed', completed_at = NOW(), error_message = $2
    WHERE id = $1
    `,
    [jobLogId, errorMessage]
  );
}

/* ===================================================
  RUN ONE SYNC STEP
  Wraps a single api.get() call with consistent logging
  and error handling, so one step's failure doesn't stop
  the rest of the sync from attempting to run.
=================================================== */

async function runSyncStep({ label, path, params, userId, results }) {
  console.log(`\n➡️  [${label}] STARTING`);
  console.log(`   GET ${path}`, { params, userId });

  const startedAt = Date.now();

  try {
    const response = await api.get(path, {
      params,
      headers: {
        "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET,
        "x-internal-user-id": String(userId)
      }
    });

    const durationMs = Date.now() - startedAt;

    // GREEN TICK
    console.log(`✅ [${label}] SYNC COMPLETED (${durationMs}ms)`);
    if (response.data?.summary) {
      console.log(`   Summary:`, response.data.summary);
    }

    results.push({
      step: label,
      status: "success",
      durationMs,
      summary: response.data?.summary || null
    });

  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const status = err.response?.status;
    const message = err.response?.data?.message || err.message;

    // RED CROSS
    console.log(`❌ [${label}] SYNC FAILED (${durationMs}ms)`);
    console.log(`   Status : ${status || "no response"}`);
    console.log(`   Error  : ${message}`);

    results.push({
      step: label,
      status: "failed",
      durationMs,
      error: message
    });

    // Intentionally does NOT re-throw — one step failing (e.g. a
    // company-specific data issue in Tally) shouldn't prevent the
    // remaining independent sync steps from being attempted.
  }
}

/* ===================================================
  MAIN JOB PROCESSOR
=================================================== */

const worker = new Worker(
  SYNC_QUEUE_NAME,

  async (job) => {
    const { jobLogId, company, fromYear, toYear, userId } = job.data;

    console.log("\n=================================================");
    console.log("[SYNC] 🔄 Job started");
    console.log("=================================================");
    console.log(`Job ID     : ${job.id}`);
    console.log(`Job Log ID : ${jobLogId}`);
    console.log(`Company    : ${company}`);
    console.log(`From Year  : ${fromYear}`);
    console.log(`To Year    : ${toYear}`);
    console.log(`User ID    : ${userId}`);
    console.log("=================================================\n");

    if (!userId) {
      const msg = `Missing userId for sync job ${job.id} (jobLogId=${jobLogId}) — refusing to run, this would fall back to resolveConnectorForCompany()'s "any live connector for this company" path and could route to the wrong user's Tally.`;
      console.log(`🚨 ${msg}`);
      await markJobFailed(jobLogId, msg);
      throw new Error(msg);
    }

    await markJobRunning(jobLogId);

    const { fromDate, toDate } = financialYearDates(fromYear, toYear);

    const results = [];

    /* ===============================================
      RUN EACH SYNC STEP IN SEQUENCE
      (sequential, not parallel — sendToTallyViaConnector
      blocks per call inside each route, so running these
      in parallel would just contend for the same single
      connector job slot rather than actually speeding
      anything up.)
    =============================================== */

    await runSyncStep({
      label: "COMPANY DETAILS",
      path: "/api/sync/company-details",
      params: { company },
      userId,
      results
    });

    await runSyncStep({
      label: "ALL LEDGERS",
      path: "/api/sync/all-ledgers-sync",
      params: { company },
      userId,
      results
    });

    await runSyncStep({
      label: "BANK ACCOUNTS",
      path: "/api/sync/group-summary-bank",
      params: { company },
      userId,
      results
    });

    await runSyncStep({
      label: "STOCK GROUP SUMMARY",
      path: "/api/sync/stock-group-summary-sync",
      params: { company },
      userId,
      results
    });

    await runSyncStep({
      label: "UNITS",
      path: "/api/sync/units-sync",
      params: { company },
      userId,
      results
    });

    await runSyncStep({
      label: "GODOWNS",
      path: "/api/sync/godown-sync",
      params: { company },
      userId,
      results
    });

    await runSyncStep({
      label: "PURCHASE/SALES LEDGERS",
      path: "/api/sync/purchase-sales-ledgers-sync",
      params: { company },
      userId,
      results
    });

    await runSyncStep({
      label: "PAYABLE/DEBTORS",
      path: "/api/sync/payable-debtors",
      params: { company },
      userId,
      results
    });

    await runSyncStep({
      label: "PARENT GROUPS",
      path: "/api/sync/parent-groups",
      params: { company },
      userId,
      results
    });

    await runSyncStep({
      label: "PROFIT & LOSS",
      path: "/api/sync/profit-loss-sync",
      params: { company, fromDate, toDate },
      userId,
      results
    });

    await runSyncStep({
      label: "PROFIT & LOSS SUMMARY",
      path: "/api/sync/profit-loss-summary-sync",
      params: { company },
      userId,
      results
    });

    await runSyncStep({
      label: "VOUCHERS",
      path: "/api/sync/voucher-sync",
      params: { company, fromDate, toDate },
      userId,
      results
    });

    /* ===============================================
      FINAL SUMMARY LOG
    =============================================== */

    const succeeded = results.filter((r) => r.status === "success").length;
    const failed = results.filter((r) => r.status === "failed").length;

    console.log("\n=================================================");
    console.log("📊 SYNC JOB SUMMARY");
    console.log("=================================================");
    console.log(`Company        : ${company}`);
    console.log(`User ID        : ${userId}`);
    console.log("-------------------------------------------------");

    /*
     * SHOW EVERY SYNC STEP
     */
    results.forEach((r) => {
      if (r.status === "success") {
        console.log(`✅ ${r.step}`);
      } else {
        console.log(`❌ ${r.step}`);
        console.log(`   Reason: ${r.error}`);
      }
    });

    console.log("-------------------------------------------------");
    console.log(`Steps Succeeded: ${succeeded}/${results.length}`);
    console.log(`Steps Failed   : ${failed}/${results.length}`);

    /*
     * FAILED STEPS DETAILS
     */
    if (failed > 0) {
      console.log("\n❌ FAILED STEPS:");
      results
        .filter((r) => r.status === "failed")
        .forEach((r) => {
          console.log(`   - ${r.step}: ${r.error}`);
        });
    }

    console.log("=================================================\n");

    // The overall job is marked "completed" even if some individual
    // steps failed — each step already recorded its own success/failure
    // in `results`, and a partial sync (e.g. vouchers succeeded but
    // godowns failed) is still meaningful progress, not a hard job
    // failure. Only a missing userId (checked above) hard-fails the job.
    await markJobCompleted(jobLogId, results);

    return {
      company,
      userId,
      totalSteps: results.length,
      succeeded,
      failed,
      results
    };
  },

  {
    connection,
    concurrency: 1
  }
);

worker.on("completed", (job, returnValue) => {
  console.log(`[SYNC] ✅ Job completed: ${job.id}`, {
    company: returnValue?.company,
    succeeded: returnValue?.succeeded,
    failed: returnValue?.failed
  });
});

worker.on("failed", (job, error) => {
  console.error(`[SYNC] ❌ Job failed: ${job?.id}`, error.message);
});

worker.on("error", (error) => {
  console.error("[SYNC] ❌ Worker error:", error.message);
});

/*
====================================
STARTUP RECOVERY

Mirrors pushBank.worker.js's recovery pair, but sync needs TWO stale
checks instead of one:

1. Stale 'pending' — /manual and /manual-auto in sync.routes.js insert the
   job_logs row and enqueue the BullMQ job as two separate steps; if the
   process dies in between, the row is left at 'pending' with no job ever
   created for it, silently, forever (confirmed live: job_logs id=52 sat
   at pending with started_at still NULL and no matching Redis job at all).

2. Stale 'running' — markJobRunning() fires the moment the worker picks a
   job up, but only markJobCompleted()/markJobFailed() (called from
   inside that same job's execution) can ever move it off 'running'. If
   the worker process itself dies mid-sync, the row is orphaned at
   'running' permanently — nothing times it out. Confirmed: 13+ jobs sat
   at 'running' for 78 minutes to 28+ hours before a one-off manual DB
   cleanup cleared them (identical completed_at timestamp across all of
   them gives it away).

   90 minutes is deliberately generous: a real sync runs 12 sequential
   internal HTTP steps, each with its own 5-minute timeout, so a slow but
   genuinely-still-working sync could take close to an hour. This must
   never fail a sync that's still actually running.
====================================
*/

const STALE_RUNNING_MINUTES = 90;

async function markStalePendingSyncAsFailed() {
  const result = await pool.query(
    `UPDATE app_test.job_logs
     SET
       status = 'failed',
       error_message = 'Sync interrupted / worker restarted before it started',
       completed_at = NOW()
     WHERE status = 'pending'
       AND job_type IN ('manual_sync')
       AND created_at < NOW() - INTERVAL '5 minutes'
     RETURNING id`
  );
  console.log(`Marked ${result.rowCount} stale pending sync jobs as failed`);
}

async function markStaleRunningSyncAsFailed() {
  const result = await pool.query(
    `UPDATE app_test.job_logs
     SET
       status = 'failed',
       error_message = 'Sync interrupted / worker restarted mid-run',
       completed_at = NOW()
     WHERE status = 'running'
       AND job_type IN ('manual_sync')
       AND started_at < NOW() - INTERVAL '${STALE_RUNNING_MINUTES} minutes'
     RETURNING id`
  );
  console.log(`Marked ${result.rowCount} stale running sync jobs as failed`);
}

async function enqueuePendingSyncJobs() {
  // Both /manual and /manual-auto only ever populate the payload jsonb
  // column, not the top-level company/company_id columns — those stay
  // NULL on every job_logs row this flow creates, so company/fromYear/
  // toYear/companyId all have to come from payload, not the row itself.
  const result = await pool.query(
    `SELECT id, user_id, payload FROM app_test.job_logs
     WHERE status = 'pending'
       AND job_type = 'manual_sync'
     ORDER BY id ASC`
  );

  let enqueuedCount = 0;

  for (const row of result.rows) {
    if (!row.user_id) continue; // pre-fix row — no safe way to attribute it, leave for manual cleanup

    const { company, companyId, fromYear, toYear } = row.payload || {};

    if (!company || !fromYear || !toYear) continue; // incomplete payload — can't safely rebuild the job

    const { action } = await safeEnqueueSync(row.id, {
      jobLogId: row.id,
      company,
      companyId,
      fromYear,
      toYear,
      userId: row.user_id
    });

    if (action === "enqueued") enqueuedCount++;
  }

  console.log(`Enqueued ${enqueuedCount} of ${result.rowCount} pending sync jobs (rest already queued/active)`);
}

(async () => {
  try {
    await markStaleRunningSyncAsFailed();
    await markStalePendingSyncAsFailed();
    await enqueuePendingSyncJobs();
  } catch (error) {
    console.error("Sync startup recovery failed:", error.message);
  }
})();

console.log("🚀 Sync Worker Started");

export default worker;