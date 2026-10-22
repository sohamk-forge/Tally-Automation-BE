console.log("🚀 postInvoiceRefresh.worker.js loaded");

/*
====================================
POST-INVOICE REFRESH

After a sales or purchase invoice is confirmed posted to Tally, read the voucher
back by its LASTVCHID, store it in app_test.vouchers (what LedgerDetail, trends
and ageing read) and move the balance snapshots by its effect (what the Ledger
list, Dashboard and receivable / payable cards read). Finally bump the company's
balances version so open pages refetch.

Never touches the invoice's sync_status: a failure here only means the pages
catch up at the next full Tally sync.
====================================
*/

import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import { POST_INVOICE_REFRESH_QUEUE_NAME } from "../queues/postInvoiceRefresh.queue.js";
import { sendToTallyViaConnector } from "../services/connectorSync.service.js";
import { resolveConnectorForCompany } from "../services/connectorOwner.service.js";
import { parseXMLKeepText } from "../services/parser.js";
import { getLedgerVoucherByMasterIdXML } from "../services/xmlBuilder.js";
import { firstVoucherNode, upsertVoucherAndRefreshBalances } from "../services/voucherUpsert.service.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  password: process.env.REDIS_PASSWORD || undefined,
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

const TABLES = {
  sales: "sales_invoice_extractions",
  purchase: "invoice_extractions"
};

// "2026-10-17" or "17-10-2026" -> "20261017"; null when unparseable. Only pins Tally's
// period; the master-ID filter does the actual matching.
function toTallyDate(value) {
  const s = value instanceof Date ? value.toISOString() : String(value || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  m = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m) return `${m[3]}${m[2]}${m[1]}`;
  return null;
}

const worker = new Worker(
  POST_INVOICE_REFRESH_QUEUE_NAME,
  async (job) => {
    const { kind, invoiceId } = job.data;
    const table = TABLES[kind];
    if (!table) throw new Error(`Unknown invoice kind "${kind}"`);

    const { rows } = await pool.query(`SELECT * FROM ${DB_SCHEMA}.${table} WHERE id = $1`, [invoiceId]);
    const row = rows[0];
    if (!row) throw new Error(`${kind} invoice ${invoiceId} not found`);

    // The result commit may not be visible yet; a status that is not success
    // after the retries means this push did not post anything to refresh.
    if (row.sync_status !== "success") {
      if (job.attemptsMade + 1 >= Number(job.opts?.attempts || 1)) {
        return { kind, invoiceId, status: "skipped", reason: `sync_status_${row.sync_status}` };
      }
      throw new Error(`${kind} invoice ${invoiceId} not committed as success yet`);
    }
    if (!row.tally_master_id) {
      return { kind, invoiceId, status: "skipped", reason: "no_tally_master_id" };
    }

    const connector = await resolveConnectorForCompany(row.company_id, row.user_id);
    if (!connector) {
      throw new Error(`No active connector found for company ${row.company_id}`);
    }

    const from = toTallyDate(row.invoice_date);
    const voucherXml = await sendToTallyViaConnector(
      row.company_id,
      getLedgerVoucherByMasterIdXML(row.company_name, row.tally_master_id, from, from),
      "sync",
      connector.user_id
    );
    const voucher = firstVoucherNode(await parseXMLKeepText(voucherXml, ["REFERENCE", "PARTYGSTIN"]));
    if (!voucher) {
      throw new Error(`Tally returned no voucher for master ID ${row.tally_master_id}`);
    }

    const { ledgersUpdated } = await upsertVoucherAndRefreshBalances(pool, {
      voucher,
      company: row.company_name,
      companyId: row.company_id
    });

    console.log("[POST-INVOICE] ✅ Voucher stored, balances refreshed", { kind, invoiceId, ledgersUpdated });
    return { kind, invoiceId, status: "refreshed", ledgersUpdated };
  },
  { connection, concurrency: 2 }
);

worker.on("failed", (job, error) => {
  console.error("[POST-INVOICE] ❌ Job failed", { jobId: job?.id, error: error.message });
});

worker.on("error", (error) => {
  console.error("[POST-INVOICE] ❌ Worker error", { error: error.message });
});
