import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: createConnectorJob
// 
// The ONLY entry point backend features should use to create work for the 
// Connector. Creates a pending row in ${DB_SCHEMA}.connector_jobs.
//
// ⚠️  IMPORTANT: userId comes from connector_pairing_token.user_id
//     NOT from connector_machine table (that table is NOT used)
//
// Called by: pushSalesInvoice.worker.js, pushLedger.worker.js, etc.
// ─────────────────────────────────────────────────────────────────────────────

export async function createConnectorJob({
  userId,
  jobType,
  requestXml,
  payload = null
}) {
  // Validate inputs
  if (!userId) {
    throw new Error("userId is required (from connector_pairing_token)");
  }

  if (!jobType) {
    throw new Error("jobType is required (e.g., 'sales_invoice', 'ledger')");
  }

  if (!requestXml) {
    throw new Error("requestXml is required (TDL/XML request body)");
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO ${DB_SCHEMA}.connector_jobs
      (
        user_id,
        job_type,
        status,
        request_xml,
        payload,
        attempt_count
      )
      VALUES
      (
        $1,
        $2,
        'pending',
        $3,
        $4,
        0
      )
      RETURNING 
        id,
        user_id,
        job_type,
        status,
        request_xml,
        payload,
        attempt_count,
        created_at
      `,
      [
        userId,        // $1: user_id from connector_pairing_token
        jobType,       // $2: job_type ('sales_invoice', 'ledger', etc.)
        requestXml,    // $3: TDL/XML request
        payload        // $4: JSON metadata { invoice_id, company_id, etc. }
      ]
    );

    const job = result.rows[0];

    console.log("✅ CONNECTOR JOB CREATED:", {
      jobId: job.id,
      userId: job.user_id,
      jobType: job.job_type,
      status: job.status,
      createdAt: job.created_at
    });

    return job;

  } catch (err) {
    console.error("❌ CREATE CONNECTOR JOB ERROR:", {
      userId,
      jobType,
      error: err.message
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// USAGE EXAMPLE from pushSalesInvoice.worker.js:
// ─────────────────────────────────────────────────────────────────────────────
//
// const connectorJob = await createConnectorJob({
//   userId: company.connector_pairing_token.user_id,  // ← From pairing token
//   jobType: 'sales_invoice',
//   requestXml: buildTallyXml(...),
//   payload: {
//     invoice_id: invoiceExtraction.id,
//     company_id: company.id,
//     invoice_no: invoiceExtraction.invoice_no,
//     customer_name: invoiceExtraction.customer_name
//   }
// });
//
// Note: The backend ONLY creates the job.
//       The connector polls GET /api/connector/jobs to claim work.
// ─────────────────────────────────────────────────────────────────────────────