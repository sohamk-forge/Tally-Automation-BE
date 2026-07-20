export async function processConnectorJobResult(client, job) {
  try {
    const { id, job_type, status, response_xml, result, payload } = job;

    console.log(
      `Processing connector job result: job_id=${id}, job_type=${job_type}, status=${status}`
    );

    switch (job_type) {
      case "ledger":
        await client.query(
          `
          UPDATE app_test.push_ledger
          SET
            status = CASE
              WHEN $1 = 'completed' THEN 'success'
              WHEN $1 = 'failed' THEN 'failed'
              ELSE status
            END,
            tally_response = $2,
            error_message = CASE
              WHEN $1 = 'failed' THEN $3
              ELSE NULL
            END,
            updated_at = NOW()
          WHERE id = $4
          `,
          [
            status,
            response_xml || null,
            result?.error || null,
            payload.ledger_id
          ]
        );

        console.log(`✅ Ledger ${payload.ledger_id} marked ${status}`);
        break;

      case "sales_invoice":
        await client.query(
          `
          UPDATE app_test.sales_invoice_extractions
          SET
            sync_status = CASE
              WHEN $1 = 'completed' THEN 'success'
              WHEN $1 = 'failed' THEN 'failed'
              ELSE sync_status
            END,
            tally_response = $2,
            error_message = CASE
              WHEN $1 = 'failed' THEN $3
              ELSE NULL
            END,
            updated_at = NOW()
          WHERE id = $4
          `,
          [
            status,
            response_xml || null,
            result?.error || null,
            payload.invoice_id
          ]
        );

        console.log(`✅ Sales Invoice ${payload.invoice_id} marked ${status}`);
        break;

      case "purchase_invoice":
        await client.query(
          `
          UPDATE app_test.invoice_extractions
          SET
            sync_status = CASE
              WHEN $1 = 'completed' THEN 'success'
              WHEN $1 = 'failed' THEN 'failed'
              ELSE sync_status
            END,
            tally_response = $2,
            error_message = CASE
              WHEN $1 = 'failed' THEN $3
              ELSE NULL
            END,
            updated_at = NOW()
          WHERE id = $4
          `,
          [
            status,
            response_xml || null,
            result?.error || null,
            payload.invoice_id
          ]
        );

        console.log(`✅ Purchase Invoice ${payload.invoice_id} marked ${status}`);
        break;

      case "stock_item":
        await client.query(
          `
          UPDATE app_test.push_stock_item
          SET
            status = CASE
              WHEN $1 = 'completed' THEN 'success'
              WHEN $1 = 'failed' THEN 'failed'
              ELSE status
            END,
            tally_response = $2,
            last_error = CASE
              WHEN $1 = 'failed' THEN $3
              ELSE NULL
            END,
            updated_at = NOW()
          WHERE id = $4
          `,
          [
            status,
            response_xml || null,
            result?.error || null,
            payload.stock_item_id
          ]
        );

        console.log(`✅ Stock Item ${payload.stock_item_id} marked ${status}`);
        break;

      case "bank":
        await client.query(
          `
          UPDATE app_test.push_bank
          SET
            sync_status = CASE
              WHEN $1 = 'completed' THEN 'success'
              WHEN $1 = 'failed' THEN 'failed'
              ELSE sync_status
            END,
            tally_response = $2,
            error_message = CASE
              WHEN $1 = 'failed' THEN $3
              ELSE NULL
            END,
            updated_at = NOW()
          WHERE id = $4
          `,
          [
            status,
            response_xml || null,
            result?.error || null,
            payload.bank_id
          ]
        );

        console.log(`✅ Bank ${payload.bank_id} marked ${status}`);
        break;

      case "odbank":
        await client.query(
          `
          UPDATE app_test.push_odbank
          SET
            status = CASE
              WHEN $1 = 'completed' THEN 'success'
              WHEN $1 = 'failed' THEN 'failed'
              ELSE status
            END,
            tally_response = $2,
            last_error = CASE
              WHEN $1 = 'failed' THEN $3
              ELSE NULL
            END,
            updated_at = NOW()
          WHERE id = $4
          `,
          [
            status,
            response_xml || null,
            result?.error || null,
            payload.odbank_id
          ]
        );

        console.log(`✅ OD Bank ${payload.odbank_id} marked ${status}`);
        break;

      case "alter_stock_item":
        await client.query(
          `
          UPDATE app_test.alter_stock_item
          SET
            status = CASE
              WHEN $1 = 'completed' THEN 'success'
              WHEN $1 = 'failed' THEN 'failed'
              ELSE status
            END,
            tally_response = $2,
            last_error = CASE
              WHEN $1 = 'failed' THEN $3
              ELSE NULL
            END,
            updated_at = NOW()
          WHERE id = $4
          `,
          [
            status,
            response_xml || null,
            result?.error || null,
            payload.alter_stock_item_id
          ]
        );

        console.log(`✅ Alter Stock Item ${payload.alter_stock_item_id} marked ${status}`);
        break;

      default:
        console.log(
          `ℹ️ CONNECTOR JOB RESULT: no handler for job_type "${job_type}", skipped business record sync`,
          { jobId: id }
        );
    }

  } catch (err) {
    console.error(
      "❌ Error processing connector job result:",
      err.message
    );
    throw err;
  }
}