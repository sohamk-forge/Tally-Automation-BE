import { Worker } from "bullmq";
import IORedis from "ioredis";
import { spawn } from "child_process";
import axios from "axios";
import path from "path";
import net from "net";

import pool from "../db/index.js";
import {
  voucherQueue,
  VOUCHER_QUEUE_NAME,
  VOUCHER_JOB_OPTIONS,
  getVoucherJobId,
  safeEnqueueVoucher
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
SAFE DATE FORMATTING (YYYYMMDD for Tally)
====================================
*/

function formatVoucherDate(rawDate, voucherId) {
  if (rawDate instanceof Date) {
    if (isNaN(rawDate.getTime())) {
      throw new Error(`Voucher ${voucherId}: voucher_date is an invalid Date object`);
    }
    const yyyy = rawDate.getUTCFullYear();
    const mm = String(rawDate.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(rawDate.getUTCDate()).padStart(2, "0");
    return `${yyyy}${mm}${dd}`;
  }

  const str = String(rawDate || "").trim();

  if (/^\d{8}$/.test(str)) {
    return str;
  }

  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const [, yyyy, mm, dd] = isoMatch;
    return `${yyyy}${mm}${dd}`;
  }

  throw new Error(`Voucher ${voucherId}: unable to parse voucher_date "${str}" into YYYYMMDD`);
}

/*
====================================
TALLY AVAILABILITY CHECK

Cheap TCP probe against Tally's XML port. Used both:
  1) as a fast pre-check before wasting a python spawn, and
  2) by the background poller that detects when Tally comes
     back online and auto re-queues pending vouchers.
====================================
*/

function isTallyOnline(host = "127.0.0.1", port = 9000, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));

    socket.connect(port, host);
  });
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
          { headers: { "Content-Type": "application/xml" }, timeout: 8000 }
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

NOTE: this only catches vouchers stuck PENDING with a stale
updated_at (e.g. a crashed worker mid-job). It does NOT touch
vouchers that are PENDING simply because Tally is closed and
being actively retried/polled — those get a fresh updated_at
on every retry attempt, so they never go stale here.
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
ENQUEUE ALL PENDING VOUCHERS

Reused both at worker startup AND by the Tally-availability
poller whenever Tally transitions from offline → online.
====================================
*/

async function enqueuePendingVoucherJobs() {
  const result = await pool.query(
    `SELECT id FROM app_test.contra_vouchers
     WHERE status = 'PENDING'
     ORDER BY id ASC`
  );

  let enqueuedCount = 0;

  for (const row of result.rows) {
    const { action } = await safeEnqueueVoucher(row.id);
    if (action === "enqueued") enqueuedCount++;
  }

  console.log(`Enqueued ${enqueuedCount} of ${result.rowCount} pending voucher jobs (rest already queued/active)`);
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

    // Fast pre-check: don't even bother spawning python if Tally is closed.
    const online = await isTallyOnline();
    if (!online) {
      await pool.query(
        `UPDATE app_test.contra_vouchers
         SET status = 'PENDING', tally_response = 'Tally is not open', updated_at = NOW()
         WHERE id = $1`,
        [voucherId]
      );
      console.log(`⏳ Voucher ${voucherId} left PENDING — Tally is not open`);
      throw Object.assign(new Error("Tally server unavailable"), { code: "ECONNREFUSED" });
    }

    try {
      const amount = Number(voucher.amount);
      const ledgers = buildLedgers(voucher, amount);
      const formattedDate = formatVoucherDate(voucher.voucher_date, voucher.id);

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
           SET status = 'SUCCESS', tally_response = $1, updated_at = NOW()
           WHERE id = $2`,
          [tallyResponse, voucherId]
        );
        console.log(`✅ Voucher Success: ${voucherId}`);
        return { voucherId, status: "success" };
      }

      // Tally rejected (non-retriable business error)
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
        await pool.query(
          `UPDATE app_test.contra_vouchers
           SET status = 'PENDING', tally_response = $1, updated_at = NOW()
           WHERE id = $2`,
          [error.message, voucherId]
        );
        throw error; // BullMQ retries; poller will also catch it once Tally is back
      }

      // Permanent (real) error → fail
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

  // Temporary/connection errors (Tally not open) must NEVER be stamped
  // FAILED here, even after BullMQ's attempts run out. Leave it PENDING —
  // the Tally-availability poller below will re-push it once Tally is back,
  // regardless of how many attempts this particular job already used.
  if (isTemporaryVoucherError(error)) {
    console.log(`⏳ Voucher ${job.data?.voucherId} stays PENDING — will retry once Tally is reachable`);
    return;
  }

  const maximumAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade < maximumAttempts) return;

  // All retries exhausted on a REAL (non-connection) error → final FAILED
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
TALLY AVAILABILITY POLLER

Runs independently of BullMQ's attempt counter. Every 20s it
checks the Tally port. The moment Tally flips from
unreachable → reachable, it re-enqueues every PENDING voucher.
This is what guarantees vouchers get pushed automatically once
you open Tally, no matter how long it was closed for or how
many BullMQ attempts a given job already burned through.
====================================
*/

let wasTallyOnline = null; // null = unknown at boot, avoids a false "back online" log on first run

async function pollTallyAndRequeue() {
  try {
    const online = await isTallyOnline();

    if (online && wasTallyOnline === false) {
      console.log("✅ Tally is back online — re-queuing all PENDING vouchers");
      await enqueuePendingVoucherJobs();
    }

    if (!online && wasTallyOnline !== false) {
      console.log("⛔ Tally is not open — vouchers will hold as PENDING until it's back");
    }

    wasTallyOnline = online;
  } catch (err) {
    console.error("Tally poll error:", err.message);
  }
}

setInterval(pollTallyAndRequeue, 20000);

/*
====================================
STARTUP RECOVERY
====================================
*/

(async () => {
  try {
    await markStalePendingAsFailed();
    await enqueuePendingVoucherJobs();
    await pollTallyAndRequeue(); // establishes the initial wasTallyOnline baseline
  } catch (error) {
    console.error("Voucher startup recovery failed:", error.message);
  }
})();

console.log("✅ Push Voucher BullMQ Worker Started");

export default worker;