console.log("🚀 finalizeSalesPrint.worker.js loaded");

/*
====================================
FINALIZE SALES PRINT

After a manual "Create Sales Invoice" push succeeds, Tally has the voucher but
the app doesn't know its auto-assigned number and has no vouchers row to print
from. This reads the voucher back by LASTVCHID, stores it in app_test.vouchers
(ledger entries + dispatch block), and records the number so the frontend can
render the existing /api/v1/voucher/:id/pdf.

A failure here only marks print_status = 'failed'. The push result
(sync_status) is never touched.
====================================
*/

import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { SALES_PRINT_QUEUE_NAME } from "../queues/salesPrint.queue.js";
import { sendToTallyViaConnector } from "../services/connectorSync.service.js";
import { resolveConnectorForCompany, getConnectorOfflineMessage } from "../services/connectorOwner.service.js";
import { parseXML, parseXMLKeepText } from "../services/parser.js";
import {
  getLedgerVoucherByMasterIdXML,
  getSalesInvoiceDetailsByMasterIdXML
} from "../services/xmlBuilder.js";
import {
  buildDeliveryNotes,
  cleanText,
  firstVoucherNode,
  upsertVoucherAndRefreshBalances
} from "../services/voucherUpsert.service.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  password: process.env.REDIS_PASSWORD || undefined,
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

async function markFailed(salesId, message) {
  await pool.query(
    `UPDATE ${DB_SCHEMA}.sales_invoice_extractions
     SET print_status = 'failed', print_error = $1, updated_at = NOW()
     WHERE id = $2`,
    [String(message).slice(0, 500), salesId]
  );
}

// "2026-10-17" or "17-10-2026" -> "20261017"; null when unparseable. Only used
// to pin Tally's period; the master-ID filter does the actual matching.
function toTallyDate(value) {
  const s = String(value || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  m = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m) return `${m[3]}${m[2]}${m[1]}`;
  return null;
}

const worker = new Worker(
  SALES_PRINT_QUEUE_NAME,
  async (job) => {
    const { salesId } = job.data;

    const { rows } = await pool.query(
      `SELECT id, company_id, company_name, user_id, invoice_date, sync_status,
              print_requested, tally_master_id
       FROM ${DB_SCHEMA}.sales_invoice_extractions WHERE id = $1`,
      [salesId]
    );
    const row = rows[0];
    if (!row) throw new Error(`Sales invoice ${salesId} not found`);

    // Never act on bulk-upload rows, or rows whose push didn't succeed.
    if (!row.print_requested) {
      return { salesId, status: "skipped", reason: "print_not_requested" };
    }
    const masterId = row.tally_master_id;
    const from = toTallyDate(row.invoice_date);
    const period = [from, from];

    try {
      if (row.sync_status !== "success" || !masterId) {
        // The result commit may not be visible yet — throw so BullMQ retries
        // with backoff. Inside the try so the last attempt records the failure.
        throw new Error(`Invoice ${salesId} not committed as success yet`);
      }

      // Same connector resolution the push uses: the requester's own connector
      // when online, otherwise any active connector for the company.
      const connector = await resolveConnectorForCompany(row.company_id, row.user_id);
      if (!connector) {
        throw new Error(
          await getConnectorOfflineMessage(
            row.company_id,
            row.user_id,
            `No active connector found for company ${row.company_id}`
          )
        );
      }
      const connectorUserId = connector.user_id;

      // Both reads are independent connector round trips: start the dispatch
      // block now and collect it after the voucher is saved. Its failure must
      // not block printing — the PDF just renders those cells empty.
      const detailsPromise = sendToTallyViaConnector(
        row.company_id,
        getSalesInvoiceDetailsByMasterIdXML(row.company_name, masterId, ...period),
        "sync",
        connectorUserId
      ).catch((detailsError) => {
        console.error("[SALES-PRINT] Delivery details fetch failed, printing without them", {
          salesId,
          error: detailsError.message
        });
        return null;
      });

      // 1) The voucher itself (ledger entries + inventory lines).
      const voucherXml = await sendToTallyViaConnector(
        row.company_id,
        getLedgerVoucherByMasterIdXML(row.company_name, masterId, ...period),
        "sync",
        connectorUserId
      );
      const voucher = firstVoucherNode(
        await parseXMLKeepText(voucherXml, ["REFERENCE", "PARTYGSTIN"])
      );
      if (!voucher) {
        throw new Error(`Tally returned no voucher for master ID ${masterId}`);
      }

      const saved = await upsertVoucherAndRefreshBalances(pool, {
        voucher,
        company: row.company_name,
        companyId: row.company_id
      });

      // 2) Dispatch / delivery block (fetched in parallel above).
      try {
        const detailsXml = await detailsPromise;
        const detailsVoucher = detailsXml ? firstVoucherNode(await parseXML(detailsXml)) : null;
        if (detailsVoucher) {
          await pool.query(
            `UPDATE ${DB_SCHEMA}.vouchers
             SET delivery_notes = $1::jsonb, updated_at = NOW()
             WHERE id = $2`,
            [JSON.stringify(buildDeliveryNotes(detailsVoucher)), saved.id]
          );
        }
      } catch (detailsError) {
        console.error("[SALES-PRINT] Delivery details save failed, printing without them", {
          salesId,
          error: detailsError.message
        });
      }

      await pool.query(
        `UPDATE ${DB_SCHEMA}.sales_invoice_extractions
         SET tally_voucher_number = $1, voucher_row_id = $2,
             print_status = 'ready', print_error = NULL, updated_at = NOW()
         WHERE id = $3`,
        [cleanText(saved.voucherNumber), saved.id, salesId]
      );

      console.log("[SALES-PRINT] ✅ Ready to print", {
        salesId,
        masterId,
        voucherNumber: saved.voucherNumber,
        voucherRowId: saved.id
      });

      return { salesId, status: "ready", voucherRowId: saved.id };
    } catch (error) {
      // Only record the failure once BullMQ has used up its attempts, so the
      // UI keeps showing "fetching" while retries are still pending.
      const maxAttempts = Number(job.opts?.attempts || 1);
      if (job.attemptsMade + 1 >= maxAttempts) {
        await markFailed(salesId, error.message);
      }
      throw error;
    }
  },
  { connection, concurrency: 2 }
);

worker.on("failed", (job, error) => {
  console.error("[SALES-PRINT] ❌ Job failed", { jobId: job?.id, error: error.message });
});

worker.on("error", (error) => {
  console.error("[SALES-PRINT] ❌ Worker error", { error: error.message });
});
