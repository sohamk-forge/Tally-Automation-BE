// Shared helper: Tally sets <STATUS>1</STATUS> even when nothing was
// actually created (missing ledger, missing stock item, missing parent
// group, etc). The connector's self-reported job status ("completed")
// can't be trusted on its own — the only reliable signal is the actual
// Tally response XML.
//
// Creates report <CREATED>; alterations report <ALTERED> with CREATED at 0.
// So the check is (CREATED + ALTERED) > 0, with EXCEPTIONS/ERRORS at 0.
// Requiring CREATED > 0 alone graded every alter job as failed even when
// Tally had accepted it.
import { storeLedgerEmbedding } from "./ledgerEmbedding.js";

function resolveTallyOutcome(responseXml) {
  let finalStatus = "failed";
  let errorMessage = null;

  try {
    const xml = responseXml || "";

    const created = parseInt(xml.match(/<CREATED>(\d+)<\/CREATED>/)?.[1] || "0");
    const altered = parseInt(xml.match(/<ALTERED>(\d+)<\/ALTERED>/)?.[1] || "0");
    const exceptions = parseInt(xml.match(/<EXCEPTIONS>(\d+)<\/EXCEPTIONS>/)?.[1] || "0");
    const errors = parseInt(xml.match(/<ERRORS>(\d+)<\/ERRORS>/)?.[1] || "0");
    const lineError = xml.match(/<LINEERROR>(.*?)<\/LINEERROR>/)?.[1] || null;

    if ((created + altered) > 0 && exceptions === 0 && errors === 0) {
      finalStatus = "success";
      errorMessage = null;
    } else {
      finalStatus = "failed";
      errorMessage = lineError || "Tally import failed";
    }
  } catch (e) {
    console.error("Error parsing Tally response:", e.message);
    finalStatus = "failed";
    errorMessage = e.message;
  }

  return { finalStatus, errorMessage };
}

export async function processConnectorJobResult(client, job) {
  try {
    const { id, job_type, status, response_xml, result, payload } = job;

    console.log(
      `Processing connector job result: job_id=${id}, job_type=${job_type}, status=${status}`
    );

    switch (job_type) {
      case "ledger": {
        const { finalStatus, errorMessage } = resolveTallyOutcome(response_xml);

        await client.query(
          `
          UPDATE app_test.push_ledger
          SET
            status = $1,
            tally_response = $2,
            error_message = $3,
            updated_at = NOW()
          WHERE id = $4
          `,
          [finalStatus, response_xml || null, errorMessage, payload.ledger_id]
        );

        console.log(`✅ Ledger ${payload.ledger_id} marked ${finalStatus}`);
        break;
      }

      case "sales_invoice": {
        const { finalStatus, errorMessage } = resolveTallyOutcome(response_xml);

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
          [finalStatus, response_xml || null, errorMessage, payload.invoice_id]
        );

        console.log(`✅ Sales Invoice ${payload.invoice_id} marked ${finalStatus}`);
        break;
      }

      case "purchase_invoice": {
        const { finalStatus, errorMessage } = resolveTallyOutcome(response_xml);

        await client.query(
          `UPDATE app_test.invoice_extractions
          SET
            sync_status = $1,
            tally_response = $2,
            error_message = $3,
            updated_at = NOW()
          WHERE id = $4
          `,
          [finalStatus, response_xml || null, errorMessage, payload.invoice_id]
        );

        console.log(`✅ Purchase Invoice ${payload.invoice_id} marked ${finalStatus}`);
        break;
      }

      case "stock_item": {
        const { finalStatus, errorMessage } = resolveTallyOutcome(response_xml);

        await client.query(
          `
          UPDATE app_test.push_stock_item
          SET
            status = $1,
            tally_response = $2,
            last_error = $3,
            updated_at = NOW()
          WHERE id = $4
          `,
          [finalStatus, response_xml || null, errorMessage, payload.stock_item_id]
        );

        console.log(`✅ Stock Item ${payload.stock_item_id} marked ${finalStatus}`);
        break;
      }

      case "bank": {
        const { finalStatus, errorMessage } = resolveTallyOutcome(response_xml);

        await client.query(
          `
          UPDATE app_test.push_bank
          SET
            sync_status = $1,
            tally_response = $2,
            error_message = $3,
            updated_at = NOW()
          WHERE id = $4
          `,
          [finalStatus, response_xml || null, errorMessage, payload.bank_id]
        );

        console.log(`✅ Bank ${payload.bank_id} marked ${finalStatus}`);
        break;
      }

      case "odbank": {
        const { finalStatus, errorMessage } = resolveTallyOutcome(response_xml);

        await client.query(
          `
          UPDATE app_test.bank_od_accounts
          SET
            sync_status = $1,
            tally_response = $2,
            error_message = $3,
            updated_at = NOW()
          WHERE id = $4
          `,
          [finalStatus, response_xml || null, errorMessage, payload.odbank_id]
        );

        console.log(`✅ OD/OC Bank ${payload.odbank_id} marked ${finalStatus}`);
        break;
      }

      case "alter_stock_item": {
        const { finalStatus, errorMessage } = resolveTallyOutcome(response_xml);

        // ✅ FIXED: was UPDATE app_test.alter_stock_item.
        // payload.alter_stock_item_id is a push_stock_item.id — the opening
        // stock worker reads and writes push_stock_item, so the result must
        // land on the same row. Pointing at a different table meant either a
        // thrown error (rolling back the whole result transaction and leaving
        // the connector job stuck) or an update to an unrelated row.
        //
        // ⚠️ NOTE: this shares push_stock_item.status with the create flow.
        // A failed opening push will leave the row at 'failed' even though
        // the item itself was created fine — check tally_response to see
        // which stage failed. Splitting the column is the real fix.
        await client.query(
          `
          UPDATE app_test.push_stock_item
          SET
            status = $1,
            tally_response = $2,
            last_error = $3,
            updated_at = NOW()
          WHERE id = $4
          `,
          [finalStatus, response_xml || null, errorMessage, payload.alter_stock_item_id]
        );

        console.log(
          `✅ Opening stock for item ${payload.alter_stock_item_id} marked ${finalStatus}`
        );
        break;
      }

      case "voucher": {
  const { finalStatus, errorMessage } = resolveTallyOutcome(response_xml);

  const voucherResult = await client.query(
    `
    UPDATE app_test.contra_vouchers
    SET
      status = $1,
      tally_response = $2,
      err_message = $3,
      duplicate_message = NULL,
      updated_at = NOW()
    WHERE id = $4
    RETURNING *
    `,
    [
      finalStatus === "success" ? "SUCCESS" : "FAILED",
      response_xml || null,
      errorMessage,
      payload.voucher_id
    ]
  );

  console.log(`✅ Voucher ${payload.voucher_id} marked ${finalStatus.toUpperCase()}`);

  // Fire-and-forget embedding on success only — same behavior as the
  // old direct-push worker. Runs inside the same DB transaction client
  // as the status update, but storeLedgerEmbedding talks to a separate
  // embedding store, not this transaction, so it can't roll it back.
  if (finalStatus === "success" && voucherResult.rows[0]) {
    const voucher = voucherResult.rows[0];
    const embedResult = await storeLedgerEmbedding({
      companyName: voucher.company_name,
      groupKey: voucher.group_key,
      ledgerName: voucher.party_ledger
    });
    if (!embedResult.stored) {
      console.log(`ℹ️ Embedding not stored for voucher ${payload.voucher_id}: ${embedResult.reason}`);
    }
  }

  break;
}

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