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

function resolveTallyOutcome(responseXml, connectorError = null) {
  let finalStatus = "failed";
  let errorMessage = null;

  // No Tally response at all (Tally unreachable, connector timeout, job
  // went stale) — surface the connector's own reason instead of the
  // generic "Tally import failed".
  if (!responseXml) {
    return {
      finalStatus: "failed",
      errorMessage: connectorError || "No response received from Tally"
    };
  }

  try {
    const xml = responseXml || "";

    const created = parseInt(xml.match(/<CREATED>(\d+)<\/CREATED>/)?.[1] || "0");
    const altered = parseInt(xml.match(/<ALTERED>(\d+)<\/ALTERED>/)?.[1] || "0");
    const exceptions = parseInt(xml.match(/<EXCEPTIONS>(\d+)<\/EXCEPTIONS>/)?.[1] || "0");
    const errors = parseInt(xml.match(/<ERRORS>(\d+)<\/ERRORS>/)?.[1] || "0");
    const lineError = xml.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/)?.[1] || null;

    if ((created + altered) > 0 && exceptions === 0 && errors === 0) {
      finalStatus = "success";
      errorMessage = null;
    } else {
      finalStatus = "failed";
      errorMessage = lineError?.trim() || connectorError || "Tally import failed";
    }
  } catch (e) {
    console.error("Error parsing Tally response:", e.message);
    finalStatus = "failed";
    errorMessage = e.message;
  }

  return { finalStatus, errorMessage };
}

// Tally's signature for "this voucher already exists, skipped" — no
// created/altered, no genuine errors, but exceptions > 0 and no LINEERROR
// text explaining why. resolveTallyOutcome() above classifies this as a
// generic "failed", which sends the user into a pointless retry loop.
// Kept as a separate check (rather than folded into resolveTallyOutcome)
// so only the sales_invoice case below opts into this distinct status —
// every other job type (ledger, stock_item, bank, etc.) keeps its exact
// current success/failed behavior.
function isPossibleDuplicateVoucher(responseXml) {
  const xml = responseXml || "";
  const created = parseInt(xml.match(/<CREATED>(\d+)<\/CREATED>/)?.[1] || "0");
  const altered = parseInt(xml.match(/<ALTERED>(\d+)<\/ALTERED>/)?.[1] || "0");
  const exceptions = parseInt(xml.match(/<EXCEPTIONS>(\d+)<\/EXCEPTIONS>/)?.[1] || "0");
  const errors = parseInt(xml.match(/<ERRORS>(\d+)<\/ERRORS>/)?.[1] || "0");
  const lineError = xml.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/)?.[1] || null;

  return created === 0 && altered === 0 && errors === 0 && exceptions > 0 && !lineError;
}

// Tally rejects a voucher that names a master it doesn't have with a
// LINEERROR like "Stock Item 'X' does not exist!" / "Ledger 'X' does not
// exist!". That isn't a generic failure — it's the same "missing master"
// case the purchase worker's own validation reports (our cached stock /
// ledger lists can be stale), so it is reported in the same shape and
// lands in the Missing screen, where the item/ledger can be created and
// the invoice retried.
function decodeXmlText(text) {
  return String(text || "")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

// Used by both purchase_invoice and sales_invoice — sales hits this when the
// synced ledger cache (all_ledger_details) still lists a customer that the
// target Tally company no longer has, so pre-push validation passes and only
// Tally itself catches it. `table` is a fixed literal from the callers below.
async function classifyMissingMasterFromTally(client, responseXml, invoiceId, table = "invoice_extractions") {
  const lineError = (responseXml || "").match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/)?.[1];
  if (!lineError) return null;

  const message = decodeXmlText(lineError);
  // Greedy capture: item names can themselves contain apostrophes
  // (e.g. "4'TH GEAR COUNTER SHAFT").
  const stockItem = message.match(/^Stock Item '(.*)' does not exist/i)?.[1];
  const ledger = message.match(/^Ledger '(.*)' does not exist/i)?.[1];
  if (!stockItem && !ledger) return null;

  const invoiceResult = await client.query(
    `SELECT raw_json FROM app_test.${table} WHERE id = $1`,
    [invoiceId]
  );
  const raw = invoiceResult.rows[0]?.raw_json;
  const invoice = typeof raw === "string" ? JSON.parse(raw) : raw || {};

  if (stockItem) {
    const line = (invoice.line_items || []).find(
      (item) => String(item.item_name || item.stock_name || item.name || "").trim() === stockItem.trim()
    );
    // Purchase lines carry `unit`; sales lines carry unit_of_measure /
    // type_of_supply (same shape validateSalesInvoice() stores).
    const unit = String(line?.unit || line?.unit_of_measure || "").trim();
    const typeOfSupply = String(line?.type_of_supply || "").trim();
    const details = unit || typeOfSupply
      ? { [stockItem]: { unit_of_measure: unit, ...(typeOfSupply ? { type_of_supply: typeOfSupply } : {}) } }
      : {};

    return {
      syncStatus: "stock_missing",
      errorMessage: JSON.stringify({
        message: `Tally: ${message}`,
        missing_ledgers: [],
        missing_stock_items: [stockItem],
        missing_stock_item_details: details
      })
    };
  }

  const partyName = String(invoice.vendor_name || invoice.party_ledger || invoice.customer_name || "").trim();
  return {
    syncStatus: "ledger_missing",
    errorMessage: JSON.stringify({
      message: `Tally: ${message}`,
      missing_ledgers: [
        { field: ledger.trim() === partyName ? "party_ledger" : "tally_ledger", ledger }
      ],
      missing_stock_items: [],
      missing_stock_item_details: {}
    })
  };
}

export async function processConnectorJobResult(client, job) {
  try {
    const { id, job_type, status, response_xml, result, payload } = job;

    // Connector-side failure reason, used when there is no Tally response
    // XML to parse (or the XML carries no LINEERROR text).
    const connectorError =
      result?.line_error || result?.error || job.error_message || null;

    console.log(
      `Processing connector job result: job_id=${id}, job_type=${job_type}, status=${status}`
    );

    switch (job_type) {
      case "ledger": {
        const { finalStatus, errorMessage } = resolveTallyOutcome(response_xml, connectorError);

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
        let { finalStatus, errorMessage } = resolveTallyOutcome(response_xml, connectorError);

        if (finalStatus === "failed" && isPossibleDuplicateVoucher(response_xml)) {
          finalStatus = "possible_duplicate";
          errorMessage =
            "Tally reports this voucher may already exist (no line error returned) — verify in Tally before retrying.";
        }

        if (finalStatus === "failed") {
          const missing = await classifyMissingMasterFromTally(
            client,
            response_xml,
            payload.invoice_id,
            "sales_invoice_extractions"
          );
          if (missing) {
            finalStatus = missing.syncStatus;
            errorMessage = missing.errorMessage;
          }
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
          [finalStatus, response_xml || null, errorMessage, payload.invoice_id]
        );

        console.log(`✅ Sales Invoice ${payload.invoice_id} marked ${finalStatus}`);
        break;
      }

      case "purchase_invoice": {
        let { finalStatus, errorMessage } = resolveTallyOutcome(response_xml, connectorError);

        if (finalStatus === "failed" && isPossibleDuplicateVoucher(response_xml)) {
          finalStatus = "possible_duplicate";
          errorMessage =
            "Tally reports this voucher may already exist (no line error returned) — verify in Tally before retrying.";
        }

        if (finalStatus === "failed") {
          const missing = await classifyMissingMasterFromTally(client, response_xml, payload.invoice_id);
          if (missing) {
            finalStatus = missing.syncStatus;
            errorMessage = missing.errorMessage;
          }
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
          [finalStatus, response_xml || null, errorMessage, payload.invoice_id]
        );

        console.log(`✅ Purchase Invoice ${payload.invoice_id} marked ${finalStatus}`);
        break;
      }

      case "stock_item": {
        const { finalStatus, errorMessage } = resolveTallyOutcome(response_xml, connectorError);

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
        const { finalStatus, errorMessage } = resolveTallyOutcome(response_xml, connectorError);

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
        const { finalStatus, errorMessage } = resolveTallyOutcome(response_xml, connectorError);

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
        const { finalStatus, errorMessage } = resolveTallyOutcome(response_xml, connectorError);

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
  const { finalStatus, errorMessage } = resolveTallyOutcome(response_xml, connectorError);

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
      companyId: voucher.company_id,
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

// Called when a connector job dies without a result (never claimed, or
// claimed and timed out). Without this, only connector_jobs was marked
// failed and the business row (e.g. invoice_extractions) stayed 'pending'
// forever.
export async function failConnectorJobBusinessRecord(client, job, message) {
  try {
    await processConnectorJobResult(client, {
      id: job.id,
      job_type: job.job_type,
      status: "failed",
      response_xml: null,
      result: { error: message },
      error_message: message,
      payload: job.payload
    });
  } catch (err) {
    console.error(
      `❌ Failed to propagate connector job ${job.id} failure to its record:`,
      err.message
    );
  }
}
