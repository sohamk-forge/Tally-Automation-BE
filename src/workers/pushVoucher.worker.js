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
  getVoucherJobId
} from "../queues/voucher.queue.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

/*
====================================
TEMPORARY ERROR DETECTION
====================================
*/

function isTemporaryVoucherError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  return [
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"
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
    message.includes("etimedout");
}

/*
====================================
BUILD LEDGERS BY VOUCHER TYPE

PAYMENT  → money OUT of bank
  - party_ledger : Dr (positive, gets the debit)
  - bank_ledger  : Cr (negative, bank goes down)

RECEIPT  → money IN to bank
  - party_ledger : Cr (negative, source gives money)
  - bank_ledger  : Dr (positive, bank goes up)

CONTRA   → bank to bank transfer
  - bank_ledger    : Cr (money leaves this bank)
  - transfer_bank  : Dr (money arrives here)
  Note: from Excel upload, transfer_bank = party_ledger (set in route)
====================================
*/

function buildLedgers(voucher, amount) {
  if (voucher.voucher_type === "payment") {
    return [
      {
        ledger_name: voucher.party_ledger,
        amount: -amount,
        is_positive: true
      },
      {
        ledger_name: voucher.bank_ledger,
        amount: amount,
        is_positive: false,
        bank_allocation: {
          bank_name: voucher.bank_ledger,
          party_name: voucher.party_ledger,
          instrument_number: voucher.instrument_number || ""
        }
      }
    ];
  }

  if (voucher.voucher_type === "receipt") {
    return [
      {
        ledger_name: voucher.party_ledger,
        amount: amount,
        is_positive: false
      },
      {
        ledger_name: voucher.bank_ledger,
        amount: -amount,
        is_positive: true,
        bank_allocation: {
          bank_name: voucher.bank_ledger,
          party_name: voucher.party_ledger,
          instrument_number: voucher.instrument_number || ""
        }
      }
    ];
  }

  if (voucher.voucher_type === "contra") {
    // transfer_bank = the destination bank
    // For Excel uploads: transfer_bank was set to party_ledger value in the route
    const destinationBank = voucher.transfer_bank || voucher.party_ledger;

    if (!destinationBank) {
      throw new Error(`Contra voucher ${voucher.id} is missing transfer_bank / party_ledger`);
    }

    return [
      {
        ledger_name: voucher.bank_ledger,
        amount: amount,
        is_positive: false
      },
      {
        ledger_name: destinationBank,
        amount: -amount,
        is_positive: true,
        bank_allocation: {
          bank_name: destinationBank,
          party_name: voucher.bank_ledger,
          instrument_number: voucher.instrument_number || ""
        }
      }
    ];
  }

  throw new Error(`Unknown voucher_type: ${voucher.voucher_type}`);
}

/*
====================================
RUN PYTHON & SEND TO TALLY
====================================
*/

function runPythonAndSendToTally(payload) {
  return new Promise((resolve, reject) => {
    const pythonFile = path.join(process.cwd(), "src", "python", "VoucherGenerator.py");

    const python = spawn("python", [pythonFile, JSON.stringify(payload)]);

    let xmlData = "";
    let errorData = "";

    python.stdout.on("data", (data) => {
      const output = data.toString();
      console.log("PYTHON OUTPUT:", output);
      xmlData += output;
    });

    python.stderr.on("data", (data) => {
      const error = data.toString();
      console.log("PYTHON ERROR:", error);
      errorData += error;
    });

    python.on("close", async (code) => {
      console.log("Python Exit Code:", code);

      if (code !== 0) {
        return reject(
          Object.assign(
            new Error(errorData || "Python process failed"),
            { isPythonError: true, errorData }
          )
        );
      }

      try {
        const response = await axios.post(
          "http://localhost:9000",
          xmlData,
          { headers: { "Content-Type": "application/xml" } }
        );

        console.log("📥 TALLY RESPONSE:", response.data);
        resolve(response.data);
      } catch (err) {
        reject(err);
      }
    });

    python.on("error", reject);
  });
}

/*
====================================
STARTUP: MARK STALE PENDING AS FAILED
====================================
*/

async function markStalePendingAsFailed() {
  const result = await pool.query(
    `UPDATE app_test.contra_vouchers
     SET
       status = 'FAILED',
       tally_response = 'Upload interrupted / Worker restarted',
       updated_at = NOW()
     WHERE status = 'PENDING'
       AND updated_at < NOW() - INTERVAL '5 minutes'
     RETURNING id`
  );
  console.log(`Marked ${result.rowCount} stale pending vouchers as failed`);
}

/*
====================================
STARTUP: ENQUEUE ALL PENDING VOUCHERS
====================================
*/

async function enqueuePendingVoucherJobs() {
  const result = await pool.query(
    `SELECT id FROM app_test.contra_vouchers
     WHERE status = 'PENDING'
     ORDER BY id ASC`
  );

  for (const row of result.rows) {
    const jobId = getVoucherJobId(row.id);
    const existingJob = await voucherQueue.getJob(jobId);

    if (existingJob) {
      const state = await existingJob.getState();
      const isProcessable = [
        "waiting", "active", "delayed", "prioritized", "paused", "waiting-children"
      ].includes(state);

      if (isProcessable) continue;
      await existingJob.remove();
    }

    await voucherQueue.add(
      "pushVoucher",
      { voucherId: row.id },
      { ...VOUCHER_JOB_OPTIONS, jobId }
    );
  }

  console.log(`Enqueued ${result.rowCount} pending voucher jobs`);
}

/*
====================================
WORKER
====================================
*/

const worker = new Worker(
  VOUCHER_QUEUE_NAME,
  async (job) => {
    const { voucherId } = job.data;

    const result = await pool.query(
      `SELECT * FROM app_test.contra_vouchers WHERE id = $1`,
      [voucherId]
    );

    const voucher = result.rows[0];

    if (!voucher) {
      console.error(`Voucher ${voucherId} not found`);
      return { voucherId, status: "not_found" };
    }

    console.log("");
    console.log("================================");
    console.log(`🚀 PROCESSING VOUCHER ID ${voucher.id}`);
    console.log(`   Type: ${voucher.voucher_type} | Amount: ${voucher.amount}`);
    console.log(`   Party: ${voucher.party_ledger} | Bank: ${voucher.bank_ledger}`);
    console.log("================================");

    try {
      const amount = Number(voucher.amount);
      const ledgers = buildLedgers(voucher, amount);

      // Format date → YYYYMMDD for Tally
      const d = new Date(voucher.voucher_date);
      const formattedDate = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

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
          `UPDATE app_test.contra_vouchers
           SET status = 'SUCCESS', tally_response = $1, synced_at = NOW(), updated_at = NOW()
           WHERE id = $2`,
          [tallyResponse, voucherId]
        );
        console.log(`✅ Voucher Success: ${voucherId}`);
        return { voucherId, status: "success" };
      }

      // Tally rejected (non-retriable)
      await pool.query(
        `UPDATE app_test.contra_vouchers
         SET status = 'FAILED', tally_response = $1, err_message = $1, updated_at = NOW()
         WHERE id = $2`,
        [tallyResponse, voucherId]
      );
      console.log(`❌ Voucher Rejected by Tally: ${voucherId}`);
      return { voucherId, status: "failed" };

    } catch (error) {
      if (isTemporaryVoucherError(error)) {
        // Network/connection error → let BullMQ retry
        await pool.query(
          `UPDATE app_test.contra_vouchers
           SET status = 'PENDING', tally_response = $1, updated_at = NOW()
           WHERE id = $2`,
          [error.message, voucherId]
        );
        throw error; // BullMQ retries
      }

      // Permanent error → fail
      await pool.query(
        `UPDATE app_test.contra_vouchers
         SET status = 'FAILED', tally_response = $1, err_message = $1, updated_at = NOW()
         WHERE id = $2`,
        [error.message, voucherId]
      );
      console.log(`💥 Voucher Failed: ${voucherId} — ${error.message}`);
      return { voucherId, status: "failed" };
    }
  },
  { connection, concurrency: 5 }
);

/*
====================================
WORKER EVENTS
====================================
*/

worker.on("completed", (job) => {
  console.log(`Voucher job completed: ${job.id}`);
});

worker.on("failed", async (job, error) => {
  console.error(`Voucher job failed: ${job?.id}`, error.message);

  if (!job) return;

  const maximumAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade < maximumAttempts) return;

  // All retries exhausted → final FAILED
  try {
    const { voucherId } = job.data;
    await pool.query(
      `UPDATE app_test.contra_vouchers
       SET status = 'FAILED', tally_response = $1, err_message = $1, updated_at = NOW()
       WHERE id = $2`,
      [error.message, voucherId]
    );
  } catch (updateError) {
    console.error(`Voucher final failure update failed: ${job.id}`, updateError.message);
  }
});

worker.on("error", (error) => {
  console.error("Voucher worker error:", error.message);
});

/*
====================================
STARTUP RECOVERY
====================================
*/

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