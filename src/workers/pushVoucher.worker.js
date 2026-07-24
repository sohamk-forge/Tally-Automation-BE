import { Worker } from "bullmq";
import IORedis from "ioredis";
import { spawn } from "child_process";
import axios from "axios";
import path from "path";

import pool from "../db/index.js";
import {
  voucherQueue,
  VOUCHER_QUEUE_NAME,
  VOUCHER_JOB_OPTIONS,
  getVoucherJobId,
  safeEnqueueVoucher
} from "../queues/voucher.queue.js";

// CHANGED: no longer imports/uses refreshVoucherDataForDay — the
// pre-push duplicate re-check no longer syncs before checking. Only
// formatVoucherDate, TALLY_URL, and checkDuplicateFromDb are needed.
import {
  formatVoucherDate,
  TALLY_URL,
  checkDuplicateFromDb
} from "../api/voucher.js";

import { storeLedgerEmbedding } from "../services/ledgerEmbedding.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

const TALLY_PUSH_TIMEOUT_MS = Number(process.env.TALLY_PUSH_TIMEOUT_MS || 8000);

function isTemporaryVoucherError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  return [
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNABORTED"
  ].includes(code) ||
    message.includes("connection timeout") ||
    message.includes("timeout") ||
    message.includes("tally server unavailable") ||
    message.includes("server unavailable") ||
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

function runPythonAndSendToTally(payload) {
  return new Promise((resolve, reject) => {
    const pythonFile = path.join(process.cwd(), "src", "python", "VoucherGenerator.py");
    const python = spawn("python", [pythonFile, JSON.stringify(payload)]);

    let xmlData = "";
    let errorData = "";

    python.stdout.on("data", (data) => { xmlData += data.toString(); });
    python.stderr.on("data", (data) => { errorData += data.toString(); });

    python.on("close", async (code) => {
      if (code !== 0) {
        return reject(Object.assign(new Error(errorData || "Python process failed"), { isPythonError: true, errorData }));
      }
      try {
        const response = await axios.post(TALLY_URL, xmlData, {
          headers: { "Content-Type": "application/xml" },
          timeout: TALLY_PUSH_TIMEOUT_MS
        });
        resolve(response.data);
      } catch (err) {
        reject(err);
      }
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

      // CHANGED: pre-push duplicate re-check now queries app_test.vouchers
      // DIRECTLY — no refreshVoucherDataForDay()/sync call anymore. This
      // means the check no longer depends on Tally being reachable at
      // push time; it depends only on the DB being reasonably up to date
      // via your existing periodic/manual sync.
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

      console.log("📤 Sending Payload:", JSON.stringify(payload, null, 2));

      const tallyResponse = await runPythonAndSendToTally(payload);
      const created = tallyResponse.includes("<CREATED>1</CREATED>");
      const altered = tallyResponse.includes("<ALTERED>1</ALTERED>");
      const success = created || altered;

      if (success) {
        await pool.query(
          `UPDATE app_test.contra_vouchers SET status = 'SUCCESS', tally_response = $1, duplicate_message = NULL, updated_at = NOW() WHERE id = $2`,
          [tallyResponse, voucherId]
        );
        console.log(`✅ Voucher Success: ${voucherId}`);

        // Learn from this confirmed voucher — fire-and-forget by design.
        // storeLedgerEmbedding() catches its own errors internally and
        // never throws, so an embedding-service hiccup can never fail
        // this job or roll back the SUCCESS status already committed above.
        const embedResult = await storeLedgerEmbedding({
          companyName: voucher.company_name,
          groupKey: voucher.group_key,
          ledgerName: voucher.party_ledger
        });
        if (!embedResult.stored) {
          console.log(`ℹ️ Embedding not stored for voucher ${voucherId}: ${embedResult.reason}`);
        }

        return { voucherId, status: "success" };
      }

      await pool.query(
        `UPDATE app_test.contra_vouchers SET status = 'FAILED', tally_response = $1, err_message = $1, updated_at = NOW() WHERE id = $2`,
        [tallyResponse, voucherId]
      );
      console.log(`❌ Voucher Rejected by Tally: ${voucherId}`);
      return { voucherId, status: "failed" };

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
  { connection, concurrency: 5 }
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

console.log("✅ Push Voucher BullMQ Worker Started");

export default worker;