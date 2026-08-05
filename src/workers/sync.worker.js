import axios from "axios";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/index.js";
import { SYNC_QUEUE_NAME } from "../queues/sync.queue.js";

import { DB_SCHEMA } from "../config/db.js";

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

async function safeSync(name, fn, results) {
  try {
    console.log(`⏳ Syncing ${name}...`);
    await fn();
    console.log(`✅ ${name} Synced`);
    results.push({ name, status: '✅ SUCCESS' });
  } catch (err) {
    console.error(`❌ ${name} Failed: ${err.message}`);
    results.push({ name, status: `❌ FAILED: ${err.message}` });
  }
}

async function processJob(job) {
  const { jobLogId, company, fromYear, toYear, userId } = job.data;
  const id = jobLogId;

  const api = axios.create({
    baseURL: process.env.BASE_URL || "http://localhost:5000",
    timeout: 300000,
    headers: {
      "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET
    }
  });

  const claimResult = await pool.query(
    `
    UPDATE ${DB_SCHEMA}.job_logs
    SET
      status = 'running',
      started_at = NOW()
    WHERE id = $1
      AND status = 'pending'
    RETURNING id
    `,
    [id]
  );

  if (claimResult.rowCount === 0) {
    console.log(`⚠️ Sync job ${id} already claimed or not pending`);
    return {
      skipped: true,
      reason: "Job already claimed or not pending"
    };
  }

  console.log(`\n===== PROCESSING JOB: ${id} =====`);
  console.log(`Company: ${company} | userId: ${userId}`);

  const finalFromDate = `${fromYear}0401`;
  const finalToDate = `${toYear}0331`;

  const results = [];

  try {
    await Promise.allSettled([
      safeSync("All Ledgers", () =>
        api.get("/api/sync/all-ledgers-sync", { params: { company } }), results),
      safeSync("Banks", () =>
        api.get("/api/sync/group-summary-bank", { params: { company } }), results),
      safeSync("Stock", () =>
        api.get("/api/sync/stock-group-summary-sync", { params: { company } }), results),
      safeSync("Units", () =>
        api.get("/api/sync/units-sync", { params: { company } }), results),
      safeSync("Godowns", () =>
        api.get("/api/sync/godown-sync", { params: { company } }), results),
      safeSync("Vouchers", () =>
        api.get("/api/sync/voucher-sync", {
          params: { company, fromDate: finalFromDate, toDate: finalToDate }
        }), results),
    ]);

    await safeSync("Purchase/Sales Ledgers", () =>
      api.get("/api/sync/purchase-sales-ledgers-sync", { params: { company } }), results);

    await safeSync("Payable/Debtors", () =>
      api.get("/api/sync/payable-debtors", { params: { company } }), results);

    let parentGroups = [];
    try {
      const pgResponse = await api.get("/api/sync/parent-groups", { params: { company } });
      parentGroups = pgResponse?.data?.data || [];
      console.log(`✅ Parent Groups Synced (${parentGroups.length} groups)`);
      results.push({ name: "Parent Groups", status: '✅ SUCCESS' });
    } catch (err) {
      console.error(`❌ Parent Groups Failed: ${err.message}`);
      results.push({ name: "Parent Groups", status: `❌ FAILED: ${err.message}` });
    }

    for (const group of parentGroups) {
      const groupName = group?.group_name;
      if (!groupName) continue;
      await safeSync(`Parent Group: ${groupName}`, () =>
        api.get("/api/sync/all-parent-groups", {
          params: { company, groupName }
        }), results);
    }

    await safeSync("Profit Loss", () =>
      api.get("/api/sync/profit-loss-sync", {
        params: { company, fromDate: finalFromDate, toDate: finalToDate }
      }), results);

    const failed = results.filter(r => r.status.includes('FAILED'));
    const success = results.filter(r => r.status.includes('SUCCESS'));

    console.log(`\n========== SYNC SUMMARY ==========`);
    results.forEach(r => console.log(`${r.status} | ${r.name}`));
    console.log(`===================================`);
    console.log(`✅ Passed: ${success.length} | ❌ Failed: ${failed.length}\n`);

    if (failed.length > 0) {
      const errorSummary = failed
        .map(r => `${r.name}: ${r.status}`)
        .join(" | ");

      await pool.query(
        `
        UPDATE ${DB_SCHEMA}.job_logs
        SET
          status = 'failed',
          error_message = $1,
          completed_at = NOW()
        WHERE id = $2
        `,
        [errorSummary, id]
      );

      console.log(`⚠️ JOB FINISHED WITH FAILURES: ${id} (${failed.length} failed)`);

      return {
        status: "failed",
        passed: success.length,
        failed: failed.length,
        results
      };
    }

    await pool.query(
      `
      UPDATE ${DB_SCHEMA}.job_logs
      SET
        status = 'completed',
        error_message = NULL,
        completed_at = NOW()
      WHERE id = $1
      `,
      [id]
    );

    console.log(`🎉 JOB COMPLETED SUCCESSFULLY: ${id}`);

    return {
      status: "completed",
      passed: success.length,
      failed: 0,
      results
    };

  } catch (err) {
    await pool.query(
      `UPDATE ${DB_SCHEMA}.job_logs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
      [`${err.message}`, id]
    );
    throw err;
  }
}

const worker = new Worker(SYNC_QUEUE_NAME, async (job) => {
  return await processJob(job);
}, { connection, concurrency: 1 });

worker.on("completed", (job) => {
  console.log(`SYNC WORKER EXECUTION FINISHED: ${job.id}`, job.returnvalue);
});
worker.on("failed", (job, err) => console.error(`SYNC JOB FAILED: ${job?.id}`, err.message));

console.log("SYNC WORKER STARTED (OPTIMIZED - PARALLEL)");