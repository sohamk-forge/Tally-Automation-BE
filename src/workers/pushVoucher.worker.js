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

// CHANGED: this worker no longer talks to Tally directly. It only
// generates the voucher XML and hands it off to the correct user's
// connector app (via connector_jobs), which pushes to THEIR local
// Tally on THEIR machine. Previously this used axios.post to
// http://localhost:9000, which hit the BACKEND SERVER's own port
// 9000 — never the user's machine — which is why vouchers were
// landing in the wrong (or no) Tally.
import { formatVoucherDate, checkDuplicateFromDb } from "../api/voucher.js";
import { createConnectorJob } from "../services/connectorJob.service.js";

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
RUN PYTHON — XML GENERATION ONLY

CHANGED: previously this spawned python AND posted the resulting XML
to http://localhost:9000 (the backend server's own Tally port). That
axios.post call has been removed entirely. This function now only
returns the generated XML string — delivering it to the user's own
local Tally is the connector app's job, via connector_jobs below.
====================================
*/

function runPythonForXml(payload) {
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

    python.on("close", (code) => {
      console.log("Python Exit Code:", code);
      if (code !== 0) {
        return reject(
          Object.assign(
            new Error(errorData || "Python process failed"),
            { isPythonError: true, errorData }
          )
        );
      }
      resolve(xmlData);
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
ENQUEUE ALL PENDING VOUCHERS
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

    if (voucher.status === "CANCELLED") {
      console.log(`🚫 Voucher ${voucherId} was cancelled — skipping push`);
      return { voucherId, status: "cancelled" };
    }

    console.log("");
    console.log("================================");
    console.log(`🚀 PROCESSING VOUCHER ID ${voucher.id}`);
    console.log(`   Type: ${voucher.voucher_type} | Amount: ${voucher.amount}`);
    console.log(`   Party: ${voucher.party_ledger} | Bank: ${voucher.bank_ledger}`);
    console.log("================================");

    try {
      const amount = Number(voucher.amount);
      const formattedDate = formatVoucherDate(voucher.voucher_date, voucher.id);

      // ── Pre-push duplicate re-check — queries app_test.vouchers
      // directly, no Tally-reachability dependency. Skipped if this
      // voucher was explicitly force-pushed (see confirm-push route).
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
      // ROUTE TO THE CORRECT USER'S CONNECTOR.
      //
      // user_id is now stored directly on the voucher row (set in
      // voucher.routes.js at party-ledger-assign / confirm-push time),
      // so no pairing-token lookup or "most recent used token" guessing
      // is needed here anymore — the owner is explicit, not inferred.
      // ─────────────────────────────────────────────────────────────
      if (!voucher.user_id) {
        throw new Error(`Voucher ${voucherId} has no user_id set — cannot route to a connector`);
      }

      const connectorJob = await createConnectorJob({
        userId: voucher.user_id,
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
        userId: voucher.user_id
      });

      // NOTE: this worker does NOT block waiting for the connector to
      // finish (unlike an earlier version). The connector app polls
      // GET /api/connector/jobs, claims the job, pushes the XML to the
      // user's own local Tally, and reports back via the connector
      // result-callback route, which is what should flip this voucher
      // from PENDING_CONNECTOR to SUCCESS/FAILED. If you want strict
      // one-at-a-time delivery per user, add a wait/poll step here and
      // drop concurrency to 1 (see bottom of file — already set to 1).
      return {
        voucherId,
        status: "pending_connector",
        connectorJobId: connectorJob.id
      };

    } catch (error) {
      if (isTemporaryVoucherError(error)) {
        await pool.query(
          `UPDATE app_test.contra_vouchers
           SET status = 'PENDING', tally_response = $1, updated_at = NOW()
           WHERE id = $2`,
          [error.message, voucherId]
        );
        throw error; // BullMQ retries per VOUCHER_JOB_OPTIONS
      }

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
  // CHANGED: concurrency 5 → 1. Serializes connector-job creation so a
  // bulk push doesn't hand the same user's connector multiple voucher
  // XMLs to race through at once.
  { connection, concurrency: 1 }
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

  if (isTemporaryVoucherError(error)) {
    console.log(`⏳ Voucher ${job.data?.voucherId} stays PENDING — will retry per BullMQ attempts/backoff`);
    return;
  }

  const maximumAttempts = Number(job.opts.attempts || 1);
  if (job.attemptsMade < maximumAttempts) return;

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

NOTE: the Tally-availability poller (setInterval checking
localhost:9000 on the SERVER) has been removed entirely — that
port belongs to the backend server, not the user's Tally, so
polling it never told us anything useful about the user's actual
Tally status. Retry/requeue now happens purely via BullMQ's
attempts/backoff on temporary errors, and via markStalePendingAsFailed
catching anything that got stuck.
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

console.log("✅ Push Voucher BullMQ Worker Started (routes via Connector)");

export default worker;