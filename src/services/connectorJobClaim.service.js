import pool from "../db/index.js";

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

export async function claimPendingConnectorJobs({ userId }) {
  // Validate input
  if (!userId) {
    throw new Error(
      "userId is required (from connector_pairing_token.user_id)"
    );
  }

  const client = await pool.connect();

  try {
    // Start transaction
    await client.query("BEGIN");

    // Step 1: Lock all pending jobs for this user
    // Step 2: Mark them as 'processing' 
    // Both happen atomically
    const result = await client.query(
      `
      WITH claimed_jobs AS (
        SELECT id
        FROM app_test.connector_jobs
        WHERE user_id = $1
          AND status = 'pending'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
      )
      UPDATE app_test.connector_jobs AS cj
      SET
        status = 'processing',
        claimed_at = NOW(),
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
      [userId]  // $1: user_id from connector's pairing token
    );

    // Commit transaction
    await client.query("COMMIT");

    // ⚠️ UPDATE ... FROM does not guarantee RETURNING preserves CTE ORDER BY
    // Re-sort to keep API response consistent (oldest jobs first)
    const sortedJobs = result.rows.sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );

    console.log("✅ CONNECTOR JOBS CLAIMED:", {
      userId,
      jobCount: sortedJobs.length,
      jobIds: sortedJobs.map(j => j.id)
    });

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