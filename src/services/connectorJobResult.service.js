import {
  alterStockItemQueue,
  ALTER_STOCK_ITEM_JOB_OPTIONS
} from "../queues/alterStockItem.queue.js";

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
  // Parse Tally response to check if invoice was actually created
  let salesStatus = status;
  let salesError = null;

  try {
    const responseXml = response_xml || "";

    const createdMatch = responseXml.match(/<CREATED>(\d+)<\/CREATED>/);
    const exceptionsMatch = responseXml.match(/<EXCEPTIONS>(\d+)<\/EXCEPTIONS>/);
    const errorMatch = responseXml.match(/<LINEERROR>(.*?)<\/LINEERROR>/);

    const created = parseInt(createdMatch?.[1] || 0);
    const exceptions = parseInt(exceptionsMatch?.[1] || 0);

    if (created > 0 && exceptions === 0) {
      salesStatus = "success";
    } else {
      salesStatus = "failed";
      salesError = errorMatch?.[1] || "Tally import failed";
    }
  } catch (e) {
    console.error("Error parsing Tally response:", e.message);
    salesStatus = "failed";
    salesError = e.message;
  }

  await client.query(
    `
    UPDATE app_test.sales_invoice_extractions
    SET
      sync_status = $1,
      tally_response = $2,
      error_message = $3,
      updated_at = NOW()
    WHERE id = $4
    `,
    [
      salesStatus,
      response_xml || null,
      salesError,
      payload.invoice_id
    ]
  );

  console.log(`✅ Sales Invoice ${payload.invoice_id} marked ${salesStatus}`);
  break;

      case "purchase_invoice":
        // Parse Tally response to check if actually created
        let invoiceStatus = status;
        let invoiceError = null;

        try {
          const responseXml = response_xml || "";
          const createdMatch = responseXml.match(/<CREATED>(\d+)<\/CREATED>/);
          const exceptionsMatch = responseXml.match(/<EXCEPTIONS>(\d+)<\/EXCEPTIONS>/);
          const errorMatch = responseXml.match(/<LINEERROR>(.*?)<\/LINEERROR>/);

          const created = parseInt(createdMatch?.[1] || 0);
          const exceptions = parseInt(exceptionsMatch?.[1] || 0);

          if (created > 0 && exceptions === 0) {
            invoiceStatus = 'success';
          } else if (exceptions > 0 || created === 0) {
            invoiceStatus = 'failed';
            invoiceError = errorMatch?.[1] || 'Tally import failed';
          }
        } catch (e) {
          console.error("Error parsing Tally response:", e.message);
        }

        await client.query(
          `UPDATE app_test.invoice_extractions
          SET
            sync_status = $1,
            tally_response = $2,
            error_message = $3,
            updated_at = NOW()
          WHERE id = $4
          `,
          [invoiceStatus, response_xml || null, invoiceError, payload.invoice_id]
        );

        console.log(`✅ Purchase Invoice ${payload.invoice_id} marked ${invoiceStatus}`);
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

        // ✅ AUTO-TRIGGER ALTER if success and has opening values!
        if (status === 'completed') {
          const stockRow = await client.query(
            `SELECT id, opening_quantity, opening_rate, opening_value
             FROM app_test.push_stock_item
             WHERE id = $1`,
            [payload.stock_item_id]
          );

          const item = stockRow.rows[0];

          if (
            item &&
            (
              Number(item.opening_quantity) > 0 ||
              Number(item.opening_rate) > 0 ||
              Number(item.opening_value) > 0
            )
          ) {
            await alterStockItemQueue.add(
              "push-alter-stock-item",
              { stockItemId: item.id },
              {
                ...ALTER_STOCK_ITEM_JOB_OPTIONS,
                jobId: `${item.id}-${Date.now()}`
              }
            );

            console.log(`✅ Auto-queued alter opening stock: ${item.id}`);
          }
        }

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
          UPDATE app_test.bank_od_accounts
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
            payload.odbank_id
          ]
        );

        console.log(`✅ OD/OC Bank ${payload.odbank_id} marked ${status}`);
        break;

      case "alter_stock_item":
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