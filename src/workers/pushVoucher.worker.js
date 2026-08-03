import { Worker } from "bullmq";
import IORedis from "ioredis";
import { spawn } from "child_process";
import path from "path";

import pool from "../db/index.js";
import {
  voucherQueue,
  VOUCHER_QUEUE_NAME,
  VOUCHER_JOB_OPTIONS,
  getVoucherJobId,
  safeEnqueueVoucher
} from "../queues/voucher.queue.js";

// CHANGED: no longer imports/uses TALLY_URL or axios — this worker no
// longer pushes to Tally directly. It only needs formatVoucherDate and
// checkDuplicateFromDb. Delivering the generated XML to the user's own
// local Tally is now the connector app's job (same split used by
// stockItem.worker.js).
import {
  formatVoucherDate,
  checkDuplicateFromDb
} from "../api/voucher.js";

import { createConnectorJob } from "../services/connectorJob.service.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

// ── NEW: how long to wait for the connector to finish THIS voucher's
// job before giving up. Combined with concurrency:1 below, this is what
// stops multiple connector jobs for the same user landing in Tally at
// the same time during bulk pushes.
const CONNECTOR_POLL_MS = 1000;
const CONNECTOR_MAX_WAIT_MS = 90000; // 90s per voucher — tune as needed

function isTemporaryVoucherError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  return [
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNABORTED"
  ].includes(code) ||
    message.includes("connection timeout") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("econnaborted") ||
    message.includes("etimedout");
}

function buildLedgers(voucher, amount) {
  if (voucher.voucher_type === "payment") {
    return [
      { ledger_name: voucher.party_ledger, amount: -amount, is_positive: true },
      {
        ledger_name: voucher.bank_ledger, amount: amount, is_positive: false,
        bank_allocation: { bank_name: voucher.bank_ledger, party_name: voucher.party_ledger, instrument_number: voucher.instrument_number || "" }
      }
    ];
  }
  if (voucher.voucher_type === "receipt") {
    return [
      { ledger_name: voucher.party_ledger, amount: amount, is_positive: false },
      {
        ledger_name: voucher.bank_ledger, amount: -amount, is_positive: true,
        bank_allocation: { bank_name: voucher.bank_ledger, party_name: voucher.party_ledger, instrument_number: voucher.instrument_number || "" }
      }
    ];
  }
  if (voucher.voucher_type === "contra") {
    const destinationBank = voucher.transfer_bank || voucher.party_ledger;
    if (!destinationBank) throw new Error(`Contra voucher ${voucher.id} is missing transfer_bank / party_ledger`);
    return [
      { ledger_name: voucher.bank_ledger, amount: amount, is_positive: false },
      {
        ledger_name: destinationBank, amount: -amount, is_positive: true,
        bank_allocation: { bank_name: destinationBank, party_name: voucher.bank_ledger, instrument_number: voucher.instrument_number || "" }
      }
    ];
  }
  throw new Error(`Unknown voucher_type: ${voucher.voucher_type}`);
}

// CHANGED: renamed from runPythonAndSendToTally — this now ONLY runs the
// Python generator and returns the XML string. It no longer posts
// anything to Tally itself; that happens on the user's machine via the
// connector app after it claims the job created below.
function runPythonForXml(payload) {
  return new Promise((resolve, reject) => {
    const pythonFile = path.join(process.cwd(), "src", "python", "VoucherGenerator.py");
    const python = spawn("python", [pythonFile, JSON.stringify(payload)]);

    let xmlData = "";
    let errorData = "";

    python.stdout.on("data", (data) => { xmlData += data.toString(); });
    python.stderr.on("data", (data) => { errorData += data.toString(); });

    python.on("close", (code) => {
      if (code !== 0) {
        return reject(Object.assign(new Error(errorData || "Python process failed"), { isPythonError: true, errorData }));
      }
      resolve(xmlData);
    });

    python.on("error", reject);
  });
}

async function markStalePendingAsFailed() {
  const result = await pool.query(
    `UPDATE app_test.contra_vouchers
     SET status = 'FAILED', tally_response = 'Upload interrupted / Worker restarted', updated_at = NOW()
     WHERE status = 'PENDING' AND updated_at < NOW() - INTERVAL '5 minutes'
     RETURNING id`
  );
  console.log(`Marked ${result.rowCount} stale pending vouchers as failed`);
}

async function enqueuePendingVoucherJobs() {
  const result = await pool.query(
    `SELECT id FROM app_test.contra_vouchers WHERE status = 'PENDING' ORDER BY id ASC`
  );
  let enqueuedCount = 0;
  for (const row of result.rows) {
    const { action } = await safeEnqueueVoucher(row.id);
    if (action === "enqueued") enqueuedCount++;
  }
  console.log(`Enqueued ${enqueuedCount} of ${result.rowCount} pending voucher jobs`);
}

// ── NEW: blocks until the connector reports completed/failed for this
// specific connector job, or until CONNECTOR_MAX_WAIT_MS elapses.
// Combined with concurrency:1, this guarantees only one connector job
// per user is ever 'pending'/'processing' at a time — so the connector
// app can never receive more than one voucher XML per poll, without
// changing anything in the connector app or connector services.
async function waitForConnectorJob(connectorJobId, voucherId) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < CONNECTOR_MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, CONNECTOR_POLL_MS));

    const { rows } = await pool.query(
      `SELECT status FROM app_test.connector_jobs WHERE id = $1`,
      [connectorJobId]
    );
    const jobStatus = rows[0]?.status;

    if (jobStatus === "completed" || jobStatus === "success") {
      console.log(`✅ Connector finished voucher ${voucherId} (job ${connectorJobId})`);
      return { outcome: "connector_completed" };
    }

    if (jobStatus === "failed") {
      console.log(`💥 Connector reported failure for voucher ${voucherId} (job ${connectorJobId})`);
      return { outcome: "connector_failed" };
    }

    // still 'pending' or 'processing' → keep waiting
  }

  console.warn(`⏳ Timed out waiting on connector job ${connectorJobId} for voucher ${voucherId}`);
  return { outcome: "connector_timeout" };
}

const worker = new Worker(
  VOUCHER_QUEUE_NAME,
  async (job) => {
    const { voucherId } = job.data;

    const result = await pool.query(`SELECT * FROM app_test.contra_vouchers WHERE id = $1`, [voucherId]);
    const voucher = result.rows[0];

    if (!voucher) return { voucherId, status: "not_found" };

    if (voucher.status === "CANCELLED") {
      console.log(`🚫 Voucher ${voucherId} was cancelled — skipping push`);
      return { voucherId, status: "cancelled" };
    }

    console.log(`\n================================\n🚀 PROCESSING VOUCHER ID ${voucher.id}\n   Type: ${voucher.voucher_type} | Amount: ${voucher.amount}\n   Party: ${voucher.party_ledger} | Bank: ${voucher.bank_ledger}\n================================`);

    try {
      const amount = Number(voucher.amount);
      const formattedDate = formatVoucherDate(voucher.voucher_date, voucher.id);

      // Pre-push duplicate re-check — queries app_test.vouchers DIRECTLY,
      // no sync/Tally-reachability dependency at push time.
      if (!voucher.force_push) {
        const voucherDateStr =
          voucher.voucher_date instanceof Date
            ? voucher.voucher_date.toISOString().split("T")[0]
            : String(voucher.voucher_date).slice(0, 10);

        const dup = await checkDuplicateFromDb({
          companyId: voucher.company_id,
          voucherType: voucher.voucher_type,
          voucherDate: voucherDateStr,
          partyLedger: voucher.party_ledger,
          bankLedger: voucher.bank_ledger,
          amount
        });

        if (dup.exists) {
          await pool.query(
            `UPDATE app_test.contra_vouchers
             SET status = 'DUPLICATE_FOUND', duplicate_checked = true, duplicate_message = $1, updated_at = NOW()
             WHERE id = $2`,
            [dup.message, voucherId]
          );
          console.log(`⚠️ Duplicate found for voucher ${voucherId} at push time — waiting on confirm-push/cancel-push`);
          return { voucherId, status: "duplicate_found" };
        }

        await pool.query(
          `UPDATE app_test.contra_vouchers SET duplicate_checked = true, duplicate_message = NULL WHERE id = $1`,
          [voucherId]
        );
      }

      // ─────────────────────────────────────────────────────────────
      // GENERATE XML ONLY. Do not push it anywhere from the server.
      // ─────────────────────────────────────────────────────────────
      const ledgers = buildLedgers(voucher, amount);
      const payload = {
        company: voucher.company_name,
        voucher_type: voucher.voucher_type,
        voucher_number: voucher.voucher_number || "",
        date: formattedDate,
        party_ledger: voucher.party_ledger,
        narration: voucher.narration || "",
        ledgers
      };

      console.log("📤 Generating XML for payload:", JSON.stringify(payload, null, 2));

      const xml = await runPythonForXml(payload);

      // ─────────────────────────────────────────────────────────────
      // FIND WHICH USER'S CONNECTOR (i.e. whose local Tally) THIS
      // VOUCHER SHOULD GO TO. Same pairing pattern as
      // stockItem.worker.js: is_used = TRUE, most recent pairing wins.
      //
      // ⚠️ INTERIM FIX ONLY — same caveat as stockItem.worker.js. If a
      // company has multiple used pairing tokens, routing is ambiguous.
      // The real fix is a user_id column on contra_vouchers set at
      // insert/upload time so the owner never has to be inferred here.
      // ─────────────────────────────────────────────────────────────
      const pairingResult = await pool.query(
        `SELECT user_id, COUNT(*) OVER () AS candidate_count
         FROM app_test.connector_pairing_tokens
         WHERE company_id = $1
           AND is_used = TRUE
         ORDER BY created_at DESC
         LIMIT 1`,
        [voucher.company_id]
      );

      const pairing = pairingResult.rows[0];

      if (!pairing) {
        throw new Error(`No connector pairing found for voucher ${voucherId}`);
      }

      if (Number(pairing.candidate_count) > 1) {
        console.warn(
          `⚠️ AMBIGUOUS PAIRING: company ${voucher.company_id} has ${pairing.candidate_count} used pairing tokens; routing voucher ${voucherId} to user ${pairing.user_id}`
        );
      }

      // ─────────────────────────────────────────────────────────────
      // CREATE CONNECTOR JOB. The frontend connector app polls
      // GET /api/connector/jobs, claims this job, pushes the XML to
      // the USER'S OWN local Tally, then reports the result back via
      // the connector-result callback route.
      // ─────────────────────────────────────────────────────────────
      const connectorJob = await createConnectorJob({
        userId: pairing.user_id,
        jobType: "voucher",
        requestXml: xml,
        payload: {
          voucher_id: voucherId,
          company_id: voucher.company_id,
          voucher_type: voucher.voucher_type
        }
      });

      await pool.query(
        `UPDATE app_test.contra_vouchers
         SET status = 'PENDING_CONNECTOR', tally_response = NULL, duplicate_message = NULL, updated_at = NOW()
         WHERE id = $1`,
        [voucherId]
      );

      console.log(`✅ Voucher connector job created: ${voucherId}`, {
        jobId: connectorJob.id,
        userId: pairing.user_id
      });

      // ─────────────────────────────────────────────────────────────
      // NEW: BLOCK HERE until the connector finishes THIS job.
      // With concurrency:1 below, this is what prevents BullMQ from
      // starting the next voucher in a bulk batch (and therefore
      // creating a second connector job for the same user) until
      // this one is fully resolved by the connector + Tally.
      // ─────────────────────────────────────────────────────────────
      const { outcome } = await waitForConnectorJob(connectorJob.id, voucherId);

      return {
        voucherId,
        status: outcome,
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      if (isTemporaryVoucherError(error)) {
        await pool.query(
          `UPDATE app_test.contra_vouchers SET status = 'PENDING', tally_response = $1, updated_at = NOW() WHERE id = $2`,
          [error.message, voucherId]
        );
        throw error; // BullMQ retries per VOUCHER_JOB_OPTIONS
      }

      await pool.query(
        `UPDATE app_test.contra_vouchers SET status = 'FAILED', tally_response = $1, err_message = $1, updated_at = NOW() WHERE id = $2`,
        [error.message, voucherId]
      );
      console.log(`💥 Voucher Failed: ${voucherId} — ${error.message}`);
      return { voucherId, status: "failed" };
    }
  },
  // ── CHANGED: concurrency 5 → 1. Combined with waitForConnectorJob
  // above, this serializes connector job creation per user so bulk
  // pushes never hand the connector more than one voucher XML at once.
  { connection, concurrency: 1 }
);

worker.on("completed", (job) => console.log(`Voucher job completed: ${job.id}`));

worker.on("failed", async (job, error) => {
  console.error(`Voucher job failed: ${job?.id}`, error.message);
  if (!job) return;

  if (isTemporaryVoucherError(error)) {
    console.log(`⏳ Voucher ${job.data?.voucherId} stays PENDING — will retry per BullMQ attempts/backoff`);
    return;
  }

  const maximumAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade < maximumAttempts) return;

  try {
    const { voucherId } = job.data;
    await pool.query(
      `UPDATE app_test.contra_vouchers SET status = 'FAILED', tally_response = $1, err_message = $1, updated_at = NOW() WHERE id = $2`,
      [error.message, voucherId]
    );
  } catch (updateError) {
    console.error(`Voucher final failure update failed: ${job.id}`, updateError.message);
  }
});

worker.on("error", (error) => console.error("Voucher worker error:", error.message));

(async () => {
  try {
    await markStalePendingAsFailed();
    await enqueuePendingVoucherJobs();
  } catch (error) {
    console.error("Voucher startup recovery failed:", error.message);
  }
})();

console.log("✅ Push Voucher BullMQ Worker Started (routes via Connector)");

export default worker;