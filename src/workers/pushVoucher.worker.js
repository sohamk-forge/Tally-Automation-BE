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

const CONNECTOR_POLL_MS = 1000;
const CONNECTOR_MAX_WAIT_MS = 90000; // 90s per voucher — tune as needed

// ── NEW: how stale a PENDING_CONNECTOR row has to be before the sweep
// gives up on it. Must be comfortably larger than CONNECTOR_MAX_WAIT_MS
// so we never sweep a voucher that's still inside a live worker's wait.
const STUCK_CONNECTOR_THRESHOLD = "10 minutes";
// How often the sweep runs while the process stays up (in addition to
// running once at startup).
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

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

// ── NEW: recovers vouchers stuck at PENDING_CONNECTOR — i.e. the
// worker created a connector job and started waiting, but the
// connector app never called back (crashed, went offline, or the
// worker itself restarted mid-wait so waitForConnectorJob never even
// finished running). These are NOT re-enqueued automatically — doing
// that blindly risks pushing a real duplicate to Tally if the
// connector actually did finish the job right before going silent
// (same race window as issue #3). Instead we fail them visibly so a
// human/route (confirm-push / party-ledger re-assign) makes the retry
// decision, same pattern as markStalePendingAsFailed for plain PENDING.
async function recoverStuckPendingConnectorVouchers() {
  const stuck = await pool.query(
    `SELECT id FROM app_test.contra_vouchers
     WHERE status = 'PENDING_CONNECTOR'
       AND updated_at < NOW() - INTERVAL '${STUCK_CONNECTOR_THRESHOLD}'`
  );

  if (!stuck.rowCount) return;

  for (const row of stuck.rows) {
    const voucherId = row.id;

    // Expire the orphaned connector job (if still pending/processing) so
    // a connector app that reconnects later doesn't push it to Tally
    // after we've already told the user it failed and let them retry —
    // that combination is exactly how a real duplicate push happens.
    const expired = await pool.query(
      `UPDATE app_test.connector_jobs
       SET status = 'failed', updated_at = NOW()
       WHERE job_type = 'voucher'
         AND status IN ('pending', 'processing')
         AND (payload->>'voucher_id')::bigint = $1
       RETURNING id`,
      [voucherId]
    );

    await pool.query(
      `UPDATE app_test.contra_vouchers
       SET status = 'FAILED',
           tally_response = 'Connector did not confirm completion in time — marked failed for manual retry. If the connector actually pushed this before going silent, re-pushing will be caught by the duplicate check.',
           updated_at = NOW()
       WHERE id = $1`,
      [voucherId]
    );

    console.warn(
      `⚠️ Recovered stuck PENDING_CONNECTOR voucher ${voucherId}` +
      (expired.rowCount ? ` (expired connector job ${expired.rows[0].id})` : ` (no live connector job found to expire)`)
    );
  }

  console.log(`Recovered ${stuck.rowCount} stuck PENDING_CONNECTOR vouchers`);
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

  // ── CHANGED: this is a WORKER-SIDE timeout only — it means we gave up
  // watching, not that the job is dead. The connector may still finish
  // it and call processConnectorJobResult later, which will correctly
  // update the voucher. We deliberately do NOT touch contra_vouchers
  // here (that would race with a legitimate late completion). The
  // periodic recoverStuckPendingConnectorVouchers() sweep is what
  // eventually resolves this if the callback truly never arrives —
  // it waits an extra buffer (10 min vs this 90s) before acting.
  console.warn(`⏳ Timed out waiting on connector job ${connectorJobId} for voucher ${voucherId} — leaving PENDING_CONNECTOR; sweep will recover it if the connector never calls back`);
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

      console.log("📤 Generating XML for payload:", JSON.stringify(payload, null, 2));

      const xml = await runPythonForXml(payload);

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
          ` AMBIGUOUS PAIRING: company ${voucher.company_id} has ${pairing.candidate_count} used pairing tokens; routing voucher ${voucherId} to user ${pairing.user_id}`
        );
      }

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
    await recoverStuckPendingConnectorVouchers();
    await enqueuePendingVoucherJobs();
  } catch (error) {
    console.error("Voucher startup recovery failed:", error.message);
  }
})();

// ── NEW: keep sweeping periodically, not just at startup — a worker
// process can run for days between restarts, and a connector app can
// go silent at any point during that window, not just right after
// deploy.
setInterval(() => {
  markStalePendingAsFailed().catch((e) => console.error("markStalePendingAsFailed sweep failed:", e.message));
  recoverStuckPendingConnectorVouchers().catch((e) => console.error("recoverStuckPendingConnectorVouchers sweep failed:", e.message));
}, SWEEP_INTERVAL_MS);

console.log("✅ Push Voucher BullMQ Worker Started (routes via Connector)");

export default worker;