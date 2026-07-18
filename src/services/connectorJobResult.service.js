// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: processConnectorJobResult
// The only entry point POST /api/connector/jobs/result should use to fan a
// completed/failed connector_jobs row out to the business record that
// originally created it. Runs on the same DB client/transaction as the
// connector_jobs UPDATE so both writes commit or roll back together.
// ─────────────────────────────────────────────────────────────────────────────

export async function processConnectorJobResult(client, job) {
  if (!job || !job.job_type) {
    console.log("ℹ️ CONNECTOR JOB RESULT: job missing job_type, nothing to sync", {
      jobId: job?.id
    });
    return;
  }

  switch (job.job_type) {
    case "sales_invoice":
      await processSalesInvoiceJobResult(client, job);
      break;

    case "ledger":
      await processLedgerJobResult(client, job);
      break;

    // TODO(stock): job_type = "stock_item" — once stock push is migrated to
    // create connector_jobs rows, update app_test.push_stock_item here.

    // TODO(voucher): job_type = "voucher" — once voucher push is migrated to
    // create connector_jobs rows, update the relevant voucher extraction
    // table here.

    default:
      console.log(`ℹ️ CONNECTOR JOB RESULT: no handler for job_type "${job.job_type}", skipped business record sync`, {
        jobId: job.id
      });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// job_type = "sales_invoice"
// Payload shape (see pushSalesInvoice.worker.js STEP 8):
//   { invoice_id, company_id, invoice_no, customer_name }
// ─────────────────────────────────────────────────────────────────────────────

async function processSalesInvoiceJobResult(client, job) {
  const invoiceId = job.payload?.invoice_id;

  if (!invoiceId) {
    console.error("❌ CONNECTOR JOB RESULT: sales_invoice job has no payload.invoice_id, cannot sync", {
      jobId: job.id
    });
    return;
  }

  if (job.status === "completed") {
    await client.query(
      `
      UPDATE app_test.sales_invoice_extractions
      SET
        sync_status = 'completed',
        tally_response = $1,
        synced_at = NOW(),
        error_message = NULL,
        last_error = NULL,
        updated_at = NOW()
      WHERE id = $2
      `,
      [job.response_xml || null, invoiceId]
    );

    console.log("✅ SALES INVOICE MARKED COMPLETED FROM CONNECTOR RESULT:", {
      jobId: job.id,
      invoiceId
    });
    return;
  }

  if (job.status === "failed") {
    const lineError = job.result?.line_error;
    const errorMessage = lineError || job.error_message || "Connector job failed";

    await client.query(
      `
      UPDATE app_test.sales_invoice_extractions
      SET
        sync_status = 'failed',
        error_message = $1,
        tally_response = $2,
        updated_at = NOW()
      WHERE id = $3
      `,
      [errorMessage, job.response_xml || null, invoiceId]
    );

    console.error("❌ SALES INVOICE MARKED FAILED FROM CONNECTOR RESULT:", {
      jobId: job.id,
      invoiceId,
      errorMessage
    });
    return;
  }

  console.log(`ℹ️ CONNECTOR JOB RESULT: status "${job.status}" ignored for sales_invoice, no business record change`, {
    jobId: job.id,
    invoiceId
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// job_type = "ledger"
// Payload shape (see pushLedger.worker.js):
//   { ledger_id, company_id, ledger_name }
// ─────────────────────────────────────────────────────────────────────────────

async function processLedgerJobResult(client, job) {
  const ledgerId = job.payload?.ledger_id;

  if (!ledgerId) {
    console.error("❌ CONNECTOR JOB RESULT: ledger job has no payload.ledger_id, cannot sync", {
      jobId: job.id
    });
    return;
  }

  if (job.status === "completed") {
    await client.query(
      `
      UPDATE app_test.push_ledger
      SET
        status = 'success',
        tally_response = $1,
        sync_at = NOW(),
        error_message = NULL,
        updated_at = NOW()
      WHERE id = $2
      `,
      [job.response_xml || null, ledgerId]
    );

    console.log("✅ LEDGER MARKED COMPLETED FROM CONNECTOR RESULT:", {
      jobId: job.id,
      ledgerId
    });
    return;
  }

  if (job.status === "failed") {
    const lineError = job.result?.line_error;
    const errorMessage = lineError || job.error_message || "Connector job failed";

    await client.query(
      `
      UPDATE app_test.push_ledger
      SET
        status = 'failed',
        error_message = $1,
        tally_response = $2,
        updated_at = NOW()
      WHERE id = $3
      `,
      [errorMessage, job.response_xml || null, ledgerId]
    );

    console.error("❌ LEDGER MARKED FAILED FROM CONNECTOR RESULT:", {
      jobId: job.id,
      ledgerId,
      errorMessage
    });
    return;
  }

  console.log(`ℹ️ CONNECTOR JOB RESULT: status "${job.status}" ignored for ledger, no business record change`, {
    jobId: job.id,
    ledgerId
  });
}
