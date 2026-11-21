import pool from "../db/index.js";
import { failConnectorJobBusinessRecord } from "./connectorJobResult.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: claimPendingConnectorJobs
//
// Called by: Connector polling GET /api/connector/jobs
// Atomically claims all pending jobs for a connector and marks them 'processing'
// in one statement, so two concurrent GET requests can never receive the same job.
//
// ⚠️  IMPORTANT: userId comes from the connector's pairing token
//     This is how the connector identifies itself.
//
// Locking strategy:
//   FOR UPDATE SKIP LOCKED → second concurrent claim skips already-locked rows
//                            instead of blocking on them
// ─────────────────────────────────────────────────────────────────────────────

// A claimed job's lease. The connector's 1s heartbeat extends it (see
// extendConnectorJobLeases), so it only lapses when the connector is gone.
const LEASE_INTERVAL = "5 minutes";
// How long an 'unknown' job (lease lapsed, no result) waits for the connector's
// outbox to deliver the result before it is failed. Longer than the connector's
// 30-minute Tally timeout.
const UNKNOWN_GRACE_INTERVAL = "35 minutes";

/**
 * Heartbeat hook: keep the leases of this user's in-flight jobs alive.
 * Only touches rows whose lease is under 4 minutes away, so this writes at most
 * about once a minute per job instead of every second.
 */
export async function extendConnectorJobLeases({ userId }) {
  await pool.query(
    `
    UPDATE app_test.connector_jobs
    SET lease_expires_at = NOW() + INTERVAL '${LEASE_INTERVAL}'
    WHERE user_id = $1
      AND status = 'processing'
      AND (lease_expires_at IS NULL OR lease_expires_at < NOW() + INTERVAL '4 minutes')
    `,
    [userId]
  );
}

/**
 * Lease reaper. Never re-queues a job (Tally may already have imported it):
 *   processing + lease lapsed -> 'unknown' (sync jobs: 'failed', nothing to protect)
 *   unknown + past grace       -> 'failed', and the business record is failed
 * A late result from the connector's outbox is still accepted for both states.
 * Pass userId to limit to one connector, omit for all (cron).
 */
export async function reapExpiredConnectorJobs({ userId = null } = {}) {
  const lapsed = `
    status = 'processing'
    AND COALESCE(lease_expires_at, claimed_at + INTERVAL '${LEASE_INTERVAL}') < NOW()
    AND ($1::bigint IS NULL OR user_id = $1)`;

  await pool.query(
    `
    UPDATE app_test.connector_jobs
    SET status = 'failed',
        error_message = 'Connector processing timeout - no result received',
        completed_at = NOW(), updated_at = NOW()
    WHERE job_type = 'sync' AND ${lapsed}
    `,
    [userId]
  );

  const unknown = await pool.query(
    `
    UPDATE app_test.connector_jobs
    SET status = 'unknown',
        error_message = 'No result received yet - waiting for connector to report',
        updated_at = NOW()
    WHERE ${lapsed}
    RETURNING id
    `,
    [userId]
  );
  if (unknown.rows.length > 0) {
    console.warn("⚠️ CONNECTOR JOBS LEASE LAPSED -> unknown:", unknown.rows.map((j) => j.id));
  }

  const expired = await pool.query(
    `
    UPDATE app_test.connector_jobs
    SET status = 'failed',
        error_message = 'No result received from connector - check Tally for this entry before retrying',
        completed_at = NOW(), updated_at = NOW()
    WHERE status = 'unknown'
      AND claimed_at < NOW() - INTERVAL '${UNKNOWN_GRACE_INTERVAL}'
      AND ($1::bigint IS NULL OR user_id = $1)
    RETURNING id, job_type, payload
    `,
    [userId]
  );
  for (const job of expired.rows) {
    await failConnectorJobBusinessRecord(
      pool,
      job,
      "No result received from connector - check Tally for this entry before retrying"
    );
  }
  if (expired.rows.length > 0) {
    console.warn("⚠️ UNKNOWN CONNECTOR JOBS PAST GRACE MARKED FAILED:", expired.rows.map((j) => j.id));
  }
}

export async function claimPendingConnectorJobs({ userId }) {
  // Validate input
  if (!userId) {
    throw new Error(
      "userId is required (from connector_pairing_token.user_id)"
    );
  }

  await reapExpiredConnectorJobs({ userId });

  const client = await pool.connect();

  try {
    // Start transaction
await client.query("BEGIN");

// =====================================================
// MARK STUCK PROCESSING JOBS AS FAILED
// =====================================================
// If connector claimed a job but never returned a result
// (connector crash, network issue, Tally timeout, etc.),
// don't leave the job stuck in "processing" forever.

// Stale handling now lives in reapExpiredConnectorJobs (lease based), run
// before this transaction and by the reaper cron.

// =====================================================
// NOW CLAIM NEW PENDING JOBS
// =====================================================

const result = await client.query(
  `
  -- ONE COMPANY AT A TIME per connector (= per Tally). Tally answers one request at a time, so
  -- syncs/pushes of different companies running together only slow each other down (and can hit the
  -- timeouts). "busy" = companies with work in flight: jobs the connector is processing right now
  -- (priority 0), or a manual sync that is running between its steps (priority 1, only while its
  -- connector jobs show activity in the last 10 minutes, so a crashed sync cannot block forever).
  -- The first one to start leads; only its pending jobs are handed out. When nothing is in flight,
  -- the oldest pending company leads. Jobs without a company (e.g. company discovery) are never held.
  WITH busy AS (
    SELECT payload->>'company_id' AS cid, 0 AS prio, MIN(claimed_at) AS since
    FROM app_test.connector_jobs
    WHERE user_id = $1
      AND status = 'processing'
      AND payload->>'company_id' IS NOT NULL
      AND COALESCE(lease_expires_at, claimed_at + INTERVAL '5 minutes') > NOW()
    GROUP BY payload->>'company_id'
    UNION ALL
    SELECT jl.payload->>'companyId', 1, jl.started_at
    FROM app_test.job_logs jl
    WHERE jl.job_type = 'manual_sync'
      AND jl.status = 'running'
      AND jl.started_at IS NOT NULL
      AND jl.payload->>'companyId' IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM app_test.connector_jobs cj
        WHERE cj.user_id = $1
          AND cj.payload->>'company_id' = jl.payload->>'companyId'
          AND cj.updated_at > NOW() - INTERVAL '10 minutes'
      )
  ),
  lead AS (
    SELECT cid FROM busy ORDER BY prio, since ASC LIMIT 1
  ),
  first_pending AS (
    SELECT payload->>'company_id' AS cid
    FROM app_test.connector_jobs
    WHERE user_id = $1
      AND status = 'pending'
      AND payload->>'company_id' IS NOT NULL
    ORDER BY created_at ASC
    LIMIT 1
  ),
  allowed AS (
    SELECT cid FROM lead
    UNION ALL
    SELECT cid FROM first_pending WHERE NOT EXISTS (SELECT 1 FROM lead)
  ),
  claimed_jobs AS (
    SELECT id
    FROM app_test.connector_jobs
    WHERE user_id = $1
      AND status = 'pending'
      AND (payload->>'company_id' IS NULL OR payload->>'company_id' IN (SELECT cid FROM allowed))
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
  )
  UPDATE app_test.connector_jobs AS cj
  SET
    status = 'processing',
    claimed_at = NOW(),
    lease_expires_at = NOW() + INTERVAL '${LEASE_INTERVAL}',
    attempt_count = COALESCE(cj.attempt_count, 0) + 1,
    last_attempt_at = NOW(),
    updated_at = NOW()
  FROM claimed_jobs
  WHERE cj.id = claimed_jobs.id
  RETURNING
    cj.id,
    cj.user_id,
    cj.job_type,
    cj.request_xml,
    cj.payload,
    cj.status,
    cj.attempt_count,
    cj.created_at
  `,
  [userId]
);

    // Commit transaction
    await client.query("COMMIT");

    // ⚠️ UPDATE ... FROM does not guarantee RETURNING preserves CTE ORDER BY
    // Re-sort to keep API response consistent (oldest jobs first)
    const sortedJobs = result.rows.sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );

    // Silent on the routine "nothing to do" poll result — this is called
    // every few seconds by every connected connector; only log when a job
    // actually got claimed, not on every empty poll.
    if (sortedJobs.length > 0) {
      console.log("[CONNECTOR-JOBS] ✅ Claimed:", {
        userId,
        jobCount: sortedJobs.length,
        jobIds: sortedJobs.map(j => j.id)
      });
    }

    return sortedJobs;

  } catch (err) {
    // Rollback on error
    await client.query("ROLLBACK");

    console.error("❌ CLAIM CONNECTOR JOBS ERROR:", {
      userId,
      error: err.message
    });

    throw err;

  } finally {
    // Always release connection back to pool
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// USAGE EXAMPLE from connector's GET /api/connector/jobs endpoint:
// ─────────────────────────────────────────────────────────────────────────────
//
// app.get('/api/connector/jobs', async (req, res) => {
//   try {
//     // Extract user_id from connector's pairing token (JWT or header)
//     const userId = req.user.id;  // ← From pairing token
//
//     const jobs = await claimPendingConnectorJobs({ userId });
//
//     res.json({
//       success: true,
//       jobs: jobs.map(job => ({
//         id: job.id,
//         jobType: job.job_type,
//         requestXml: job.request_xml,
//         payload: job.payload
//       }))
//     });
//
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });
//
// ─────────────────────────────────────────────────────────────────────────────
// FLOW:
//
// 1. Backend creates job:
//    createConnectorJob({ 
//      userId: pairingToken.user_id,
//      jobType: 'sales_invoice',
//      requestXml: '...',
//      payload: { invoice_id: 123, ... }
//    })
//
// 2. Connector polls for work:
//    GET /api/connector/jobs 
//    → claimPendingConnectorJobs({ userId: pairingToken.user_id })
//
// 3. Connector processes jobs and calls:
//    POST /api/connector/jobs/result
//    with completed/failed status
//
// 4. Backend syncs results back to business tables:
//    processConnectorJobResult(client, job)
// ─────────────────────────────────────────────────────────────────────────────        