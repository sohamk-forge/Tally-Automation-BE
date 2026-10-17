import { Worker, UnrecoverableError } from "bullmq";
import IORedis from "ioredis";
import axios from "axios";

import pool from "../db/index.js";
import { SYNC_STEP_COUNT } from "../config/syncSteps.js";
import { failConnectorJobBusinessRecord } from "../services/connectorJobResult.service.js";
import { SYNC_QUEUE_NAME, safeEnqueueSync, syncQueue, getSyncJobId, PROCESSABLE_STATES } from "../queues/sync.queue.js";
import { CONNECTOR_WAIT_TIMEOUT_MS, CONNECTOR_NOT_PICKING_UP_CODE } from "../services/connectorSync.service.js";
import { recordTallyLicence, LICENCE_INACTIVE_MESSAGE } from "../services/tallyLicence.service.js";
import { resolveSyncRange } from "../utils/financialYears.js";
import { recordFinancialYears } from "../services/companyFinancialYears.service.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  password: process.env.REDIS_PASSWORD || undefined,
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

// Derived from PORT rather than a separately hardcoded fallback — a stale
// literal here (previously "http://localhost:5000", not this server's
// actual port) silently misdirected every internal sync-step call. On
// macOS, port 5000 in particular is claimed by the OS's own AirPlay
// Receiver, which replies 403 to everything — that's what made all 12
// sync steps fail identically with "status code 403", with connector_jobs
// never even getting created since these calls never reached this
// server's own routes at all.
const api = axios.create({
  baseURL: process.env.BASE_URL || `http://localhost:${process.env.PORT || 5001}`,
  timeout: 300000,
  headers: {
    "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET
  }
});

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

// Writes the results array so far to raw_response after each step, not
// just once at the end — this is what lets GET /status/:jobId report real
// step-by-step progress instead of the frontend's old fake fixed-timer
// animation. Best-effort: a failure here should never abort the sync
// itself, just leave that one step's progress unreflected until the next
// step's write catches up.
async function updateJobProgress(jobLogId, results) {
  try {
    await pool.query(
      `
      UPDATE app_test.job_logs
      SET raw_response = $2
      WHERE id = $1
      `,
      [jobLogId, JSON.stringify(results)]
    );
  } catch (err) {
    console.error(`Failed to write progress for job ${jobLogId}:`, err.message);
  }
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

// Raised by a step when the connector is not picking up requests at all. Unlike an ordinary
// step failure, continuing would just repeat the same 2-minute wait 13 more times.
class ConnectorNotPickingUpError extends Error {}

// connectorCalls = how many sequential connector requests the route makes. Each may wait up
// to CONNECTOR_WAIT_TIMEOUT_MS, so the HTTP timeout is derived from it (plus a minute for
// the database work) and can never be shorter than the wait it is waiting on.
// Adds up the numeric fields of the per-financial-year summaries into the one summary a step reports.
function mergeSummaries(summaries) {
  const present = summaries.filter(Boolean);
  if (present.length <= 1) return present[0] || null;
  const merged = {};
  for (const summary of present) {
    for (const [key, value] of Object.entries(summary)) {
      if (typeof value === "number") merged[key] = (merged[key] || 0) + value;
    }
  }
  return merged;
}

// `pieces` (financial-year ranges): the route is called once per piece, oldest first, and the step reports
// one combined result - so a three-year sync is still the same N steps in the progress loader.
async function runSyncStep({ label, path, params, pieces, userId, results, jobLogId, connectorCalls = 1 }) {
  console.log(`\n➡️  [${label}] STARTING`);
  console.log(`   GET ${path}`, { params, userId });

  const startedAt = Date.now();

  try {
    const calls = pieces?.length
      ? pieces.map((piece) => ({ piece, params: { ...params, fromDate: piece.fromDate, toDate: piece.toDate } }))
      : [{ piece: null, params }];

    const summaries = [];
    for (const call of calls) {
      try {
        const response = await api.get(path, {
          params: call.params,
          timeout: connectorCalls * CONNECTOR_WAIT_TIMEOUT_MS + 60000,
          headers: {
            "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET,
            "x-internal-user-id": String(userId)
          }
        });
        if (call.piece) console.log(`   FY ${call.piece.label} (${call.piece.fromDate} -> ${call.piece.toDate}) done`);
        summaries.push(response.data?.summary || null);
      } catch (err) {
        // Say which financial year failed; earlier years are already saved.
        if (call.piece && calls.length > 1) err.message = `FY ${call.piece.label}: ${err.response?.data?.message || err.message}`;
        throw err;
      }
    }

    const durationMs = Date.now() - startedAt;

    // GREEN TICK
    console.log(`✅ [${label}] SYNC COMPLETED (${durationMs}ms)`);

    const summary = mergeSummaries(summaries);
    if (summary) {
      console.log(`   Summary:`, summary);
    }
    const failedRecords = Number(summary?.failed) || 0;

    // A 200 with per-record failures (e.g. vouchers rejected by a DB
    // constraint) is not a clean success — surface it instead of a green tick.
    if (failedRecords > 0) {
      results.push({
        step: label,
        status: "failed",
        durationMs,
        summary,
        error: `${failedRecords} of ${summary?.total ?? summary?.total_found ?? "?"} records failed to save`
      });
    } else {
      results.push({ step: label, status: "success", durationMs, summary });
    }
    await updateJobProgress(jobLogId, results);

  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const status = err.response?.status;
    const rawMessage = err.response?.data?.message || err.message;
    const connectorDown = String(rawMessage).includes(CONNECTOR_NOT_PICKING_UP_CODE);
    const message = String(rawMessage).replace(CONNECTOR_NOT_PICKING_UP_CODE, "").trim();

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
    await updateJobProgress(jobLogId, results);

    if (connectorDown) throw new ConnectorNotPickingUpError(message);

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
    const { jobLogId, company, companyId, fromYear, toYear, fromDate: requestedFrom, toDate: requestedTo, userId } = job.data;

    console.log("\n=================================================");
    console.log("[SYNC] 🔄 Job started");
    console.log("=================================================");
    console.log(`Job ID     : ${job.id}`);
    console.log(`Job Log ID : ${jobLogId}`);
    console.log(`Company    : ${company}`);
    console.log(`From Year  : ${fromYear}`);
    console.log(`To Year    : ${toYear}`);
    console.log(`Range      : ${requestedFrom || "-"} -> ${requestedTo || "-"}`);
    console.log(`User ID    : ${userId}`);
    console.log("=================================================\n");

    if (!userId) {
      const msg = `Missing userId for sync job ${job.id} (jobLogId=${jobLogId}) — refusing to run, this would fall back to resolveConnectorForCompany()'s "any live connector for this company" path and could route to the wrong user's Tally.`;
      console.log(`🚨 ${msg}`);
      await markJobFailed(jobLogId, msg);
      throw new Error(msg);
    }

    await markJobRunning(jobLogId);

    // The range to pull, split into financial years (1 Apr -> 31 Mar), oldest first. A connector that
    // sends real dates gets exactly that range; older ones send two years, read as whole financial years.
    const pieces = resolveSyncRange({ fromDate: requestedFrom, toDate: requestedTo, fromYear, toYear });
    if (!pieces.length) {
      const msg = `Invalid sync period (${requestedFrom || fromYear} to ${requestedTo || toYear})`;
      await markJobFailed(jobLogId, msg);
      throw new UnrecoverableError(msg);
    }
    console.log(`Financial years: ${pieces.map((p) => `${p.label} [${p.fromDate}-${p.toDate}]`).join(", ")}`);

    const results = [];

    /* ===============================================
      RUN EACH SYNC STEP IN SEQUENCE
      (sequential, not parallel — sendToTallyViaConnector
      blocks per call inside each route, so running these
      in parallel would just contend for the same single
      connector job slot rather than actually speeding
      anything up.)
    =============================================== */

    // The steps, in the order they must run. `calls` = connector requests the route makes in a
    // row (used for its timeout); `dated` = the route also takes the financial-year dates.
    const SYNC_STEPS = [
      { label: "COMPANY DETAILS", path: "/api/sync/company-details", calls: 2 },
      { label: "ALL LEDGERS", path: "/api/sync/all-ledgers-sync", calls: 2 },
      { label: "BANK ACCOUNTS", path: "/api/sync/group-summary-bank" },
      { label: "STOCK GROUP GST DETAILS", path: "/api/sync/stock-group-gst-sync" },
      { label: "STOCK GROUP SUMMARY", path: "/api/sync/stock-group-summary-sync" },
      { label: "UNITS", path: "/api/sync/units-sync" },
      { label: "GODOWNS", path: "/api/sync/godown-sync" },
      { label: "PURCHASE/SALES LEDGERS", path: "/api/sync/purchase-sales-ledgers-sync" },
      { label: "PAYABLE/DEBTORS", path: "/api/sync/payable-debtors", calls: 6 },
      { label: "PARENT GROUPS", path: "/api/sync/parent-groups" },
      { label: "PROFIT & LOSS", path: "/api/sync/profit-loss-sync", dated: true },
      { label: "PROFIT & LOSS SUMMARY", path: "/api/sync/profit-loss-summary-sync" },
      { label: "VOUCHERS", path: "/api/sync/voucher-sync", dated: true },
      // Must run AFTER voucher-sync - this route only UPDATEs the delivery_notes column on
      // voucher rows voucher-sync already inserted, it never inserts rows itself.
      { label: "SALES INVOICE DELIVERY DETAILS", path: "/api/sync/sales-invoice-details-sync", dated: true }
    ];

    try {
      // Is the Tally licence active? Asked once, here, whenever a sync starts (a manual sync, or the
      // first sync a connector pairing starts). Educational mode (false) refuses the sync; "could not
      // tell" (null) does not, so a Tally that is slow to answer never blocks anybody by mistake.
      const licensed = await recordTallyLicence(companyId, userId);
      if (licensed === false) {
        await markJobFailed(jobLogId, LICENCE_INACTIVE_MESSAGE);
        throw new UnrecoverableError(LICENCE_INACTIVE_MESSAGE);
      }

      for (const step of SYNC_STEPS) {
        await runSyncStep({
          label: step.label,
          path: step.path,
          params: { company, companyId },
          pieces: step.dated ? pieces : undefined,
          connectorCalls: step.calls,
          userId,
          results,
          jobLogId
        });

        // Vouchers are the data a financial year is for: remember the years only once they were pulled.
        if (step.label === "VOUCHERS" && results.at(-1)?.status === "success") {
          await recordFinancialYears(companyId, pieces);
        }
      }
    } catch (err) {
      const connectorDown = err instanceof ConnectorNotPickingUpError || String(err.message).includes(CONNECTOR_NOT_PICKING_UP_CODE);
      if (!connectorDown) throw err;
      // The connector is not taking any work: stop here, say why, and do not retry the
      // whole sync (it would just wait again).
      const message = String(err.message).replace(CONNECTOR_NOT_PICKING_UP_CODE, "").trim();
      await markJobFailed(jobLogId, message);
      throw new UnrecoverableError(message);
    }

    /* ===============================================
      FINAL SUMMARY LOG
    =============================================== */

    if (results.length !== SYNC_STEP_COUNT) {
      console.warn(
        `⚠️ Sync ran ${results.length} steps but src/config/syncSteps.js says ${SYNC_STEP_COUNT} — update SYNC_STEP_COUNT so the progress loader's "x / N" is right.`
      );
    }

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
    // Was 1 — a single GLOBAL slot for every user's sync, system-wide, not
    // per-user/company. Each sync runs 12-13 sequential internal steps,
    // each with its own 5-minute timeout, so one slow (or genuinely stuck)
    // sync could hold that one slot for a long time, leaving every other
    // unrelated user's sync sitting at 'pending' behind it — the actual
    // cause of the "5 min cooling period" users were seeing, not an
    // intentional rate limit (there wasn't one). Raised to a small pool so
    // unrelated syncs run concurrently instead of fully serializing. This
    // only lets multiple DIFFERENT syncs run at once — each individual
    // sync's own 13 steps still run sequentially, unaffected.
    concurrency: 5
  }
);

worker.on("completed", (job, returnValue) => {
  console.log(`[SYNC] ✅ Job completed: ${job.id}`, {
    company: returnValue?.company,
    succeeded: returnValue?.succeeded,
    failed: returnValue?.failed
  });
});

worker.on("failed", async (job, error) => {
  console.error(`[SYNC] ❌ Job failed: ${job?.id}`, error.message);

  // BullMQ gave up on this job (stalled after a crash/restart, retries used up, or we threw
  // UnrecoverableError). Nothing else will ever move its job_logs row off 'running', so close
  // it here. Attempts BullMQ is going to retry are left alone.
  const finalFailure =
    error?.name === "UnrecoverableError" ||
    /stalled more than allowable limit/i.test(error?.message || "") ||
    (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? 1);
  const jobLogId = job?.data?.jobLogId;
  if (!finalFailure || !jobLogId) return;

  try {
    await pool.query(
      `
      UPDATE app_test.job_logs
      SET status = 'failed', completed_at = NOW(), error_message = $2
      WHERE id = $1 AND status IN ('pending', 'running')
      `,
      [jobLogId, error.message]
    );
  } catch (dbError) {
    console.error(`[SYNC] Could not close job_logs ${jobLogId}:`, dbError.message);
  }
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

// Previously only ever called once, at worker startup — safe there
// because nothing could legitimately be mid-flight yet. Now also run on a
// recurring interval (see the setInterval below) so a genuinely orphaned
// row doesn't sit silently forever between restarts — but on a recurring
// schedule the startup-time assumption no longer holds: with concurrency
// raised above 1, a 'pending' row can be perfectly healthy, just waiting
// behind other jobs for a free slot. So first check whether a live,
// still-processable BullMQ job actually exists for each candidate row —
// only mark it failed if there's genuinely nothing behind it (the actual
// orphaned case this was written for), not just because it's been
// waiting a while.
async function markStalePendingSyncAsFailed() {
  const candidates = await pool.query(
    `SELECT id FROM app_test.job_logs
     WHERE status = 'pending'
       AND job_type IN ('manual_sync')
       AND created_at < NOW() - INTERVAL '5 minutes'`
  );

  let failedCount = 0;

  for (const row of candidates.rows) {
    const existingJob = await syncQueue.getJob(getSyncJobId(row.id));
    if (existingJob) {
      const state = await existingJob.getState();
      if (PROCESSABLE_STATES.includes(state)) continue; // genuinely still queued, not stuck
    }

    const updated = await pool.query(
      `UPDATE app_test.job_logs
       SET status = 'failed',
           error_message = 'Sync interrupted / worker restarted before it started',
           completed_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [row.id]
    );
    if (updated.rowCount > 0) failedCount++;
  }

  if (failedCount > 0) {
    console.log(`Marked ${failedCount} stale pending sync jobs as failed`);
  }
}

async function markStaleRunningSyncAsFailed() {
  const candidates = await pool.query(
    `SELECT id FROM app_test.job_logs
     WHERE status = 'running'
       AND job_type IN ('manual_sync')
       AND started_at < NOW() - INTERVAL '${STALE_RUNNING_MINUTES} minutes'`
  );

  let failedCount = 0;
  for (const row of candidates.rows) {
    // A long but live sync (slow Tally, large voucher list) must never be failed by this
    // sweep: only a row whose BullMQ job is not actively running is really orphaned.
    const existingJob = await syncQueue.getJob(getSyncJobId(row.id));
    if (existingJob && (await existingJob.getState()) === "active") continue;

    const updated = await pool.query(
      `UPDATE app_test.job_logs
       SET status = 'failed',
           error_message = 'Sync interrupted / worker restarted mid-run',
           completed_at = NOW()
       WHERE id = $1 AND status = 'running'
       RETURNING id`,
      [row.id]
    );
    if (updated.rowCount > 0) failedCount++;
  }

  console.log(`Marked ${failedCount} stale running sync jobs as failed`);
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

    const { company, companyId, fromYear, toYear, fromDate, toDate } = row.payload || {};

    if (!company || !fromYear || !toYear) continue; // incomplete payload — can't safely rebuild the job

    const { action } = await safeEnqueueSync(row.id, {
      jobLogId: row.id,
      company,
      companyId,
      fromYear,
      toYear,
      fromDate,
      toDate,
      userId: row.user_id
    });

    if (action === "enqueued") enqueuedCount++;
  }

  console.log(`Enqueued ${enqueuedCount} of ${result.rowCount} pending sync jobs (rest already queued/active)`);
}

// connector_jobs had no staleness handling at all for rows stuck 'pending'
// (never claimed by a connector) — unlike 'processing' rows, which
// connectorJobClaim.service.js already sweeps, but only lazily, as a side
// effect of that SAME user's connector polling (so it never fires if that
// connector is offline). A row here stuck pending usually means the
// user's connector app isn't running/online to ever claim it. 10 minutes
// matches waitForConnectorSyncJob's own existing wait timeout in
// connectorSync.service.js, so this lines up with when the caller HTTP
// request itself would already have given up waiting.
const CONNECTOR_JOB_STALE_PENDING_MINUTES = 10;

async function markStalePendingConnectorJobsAsFailed() {
  const result = await pool.query(
    `UPDATE app_test.connector_jobs
     SET status = 'failed',
         error_message = 'Connector never came online to claim this job',
         completed_at = NOW(),
         updated_at = NOW()
     WHERE status = 'pending'
       AND created_at < NOW() - INTERVAL '${CONNECTOR_JOB_STALE_PENDING_MINUTES} minutes'
     RETURNING id, job_type, payload`
  );
  if (result.rowCount > 0) {
    console.log(`Marked ${result.rowCount} stale pending connector jobs as failed`);
  }

  // Without this the linked business row (e.g. a purchase invoice) stayed
  // 'pending' forever while only connector_jobs showed the failure.
  for (const job of result.rows) {
    if (job.job_type === "sync") continue;
    await failConnectorJobBusinessRecord(
      pool,
      job,
      "Connector never came online to claim this job"
    );
  }
}

async function runStalenessSweep() {
  try {
    await markStaleRunningSyncAsFailed();
    await markStalePendingSyncAsFailed();
    await markStalePendingConnectorJobsAsFailed();
  } catch (error) {
    console.error("Sync staleness sweep failed:", error.message);
  }
}

const STALENESS_SWEEP_INTERVAL_MS = 2 * 60 * 1000;

(async () => {
  try {
    await runStalenessSweep();
    await enqueuePendingSyncJobs();
  } catch (error) {
    console.error("Sync startup recovery failed:", error.message);
  }

  // Was previously only ever run once, here at startup — a genuinely
  // orphaned job_logs/connector_jobs row (the INSERT-then-enqueue race, or
  // a connector that never comes online) had no way to ever get cleaned
  // up between restarts. Now re-checked on a recurring interval instead.
  setInterval(runStalenessSweep, STALENESS_SWEEP_INTERVAL_MS);
})();

console.log("🚀 Sync Worker Started");

export default worker;