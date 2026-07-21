/* ===================================================
   SYNC WORKER (BULLMQ VERSION)
=================================================== */

import axios from "axios";
import { Worker } from "bullmq";
import IORedis from "ioredis";

import pool from "../db/index.js";
import { DB_SCHEMA } from "../config/db.js";
import {
  SYNC_QUEUE_NAME
} from "../queues/sync.queue.js";

/* ===================================================
   REDIS CONNECTION
=================================================== */

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

/* ===================================================
   DELAY
=================================================== */

const delay = (ms) =>
  new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );

/* ===================================================
   AXIOS CONFIG
=================================================== */

const api = axios.create({
  baseURL: "http://localhost:5000",
  timeout: 300000
});

/* ===================================================
   PROCESS JOB
=================================================== */

async function processJob(job) {
  // CHANGED: Added fromYear and toYear to the destructuring
  const {
    jobLogId,
    company,
    fromYear,
    toYear
  } = job.data;

  const id = jobLogId;

  try {
    /* =====================================
       UPDATE STATUS → RUNNING
    ===================================== */
    await pool.query(
      `
      UPDATE ${DB_SCHEMA}.job_logs
      SET
        status = 'running',
        started_at = NOW()
      WHERE id = $1
        AND status = 'pending'
      `,
      [id]
    );

    console.log("\n");
    console.log("=====================================");
    console.log(`PROCESSING JOB ID: ${id}`);
    console.log("=====================================");

    // CHANGED: Use fromYear and toYear from job.data instead of database
    const fromDate = fromYear;
    const toDate = toYear;

    const finalFromDate = `${fromDate}0401`;
    const finalToDate   = `${toDate}0331`;

    if (!fromDate || !toDate) {
      throw new Error("Financial year not provided.");
    }

    console.log(`Company: ${company}`);
    console.log("fromDate =", fromDate);
    console.log("toDate =", toDate);
    console.log("finalFromDate =", finalFromDate);
    console.log("finalToDate =", finalToDate);

    /* =====================================
       1. LEDGER SYNC
    ===================================== */
    console.log("Syncing Ledgers...");
    await api.get("/api/sync/ledgers", {
      params: { company }
    });
    console.log("Ledgers Synced");
    await delay(3000);

    /* =====================================
       2. VOUCHER SYNC
    ===================================== */
    console.log("Syncing Vouchers...");
    await api.get("/api/sync/voucher-sync", {
      params: {
        company,
        fromDate: finalFromDate,
        toDate: finalToDate
      }
    });
    console.log("Vouchers Synced");
    await delay(5000);

    /* =====================================
       3. ALL LEDGER DETAILS
    ===================================== */
    console.log("Syncing All Ledger Details...");
    await api.get("/api/sync/all-ledgers-sync", {
      params: { company }
    });
    console.log("All Ledger Details Synced");
    await delay(3000);

    /* =====================================
       4. BANKS
    ===================================== */
    console.log("Syncing Banks...");
    await api.get("/api/sync/group-summary-bank", {
      params: { company }
    });
    console.log("Banks Synced");
    await delay(3000);

    /* =====================================
       5. PARENT GROUPS
    ===================================== */
    console.log("Syncing Parent Groups...");
    const parentGroupsResponse = await api.get("/api/sync/parent-groups", {
      params: { company }
    });
    console.log("Parent Groups Synced");
    await delay(3000);

    /* =====================================
       6. ALL PARENT GROUPS (LOOP)
    ===================================== */
    const parentGroups = parentGroupsResponse?.data?.data || [];
    for (const group of parentGroups) {
      try {
        const groupName = group?.group_name;
        if (!groupName) continue;

        console.log(`Syncing Group: ${groupName}`);
        await api.get("/api/sync/all-parent-groups", {
          params: { company, groupName }
        });
        console.log(`${groupName} Synced`);
        await delay(3000);
      } catch (groupError) {
        console.log(`Group Failed: ${groupError.message}`);
      }
    }

    /* =====================================
       7. PAYABLE DEBTORS (GROUP BALANCES)
    ===================================== */
    console.log("Syncing Payable Debtors...");
    await api.get("/api/sync/payable-debtors", {
      params: { company }
    });
    console.log("Payable Debtors Synced");
    await delay(3000);

    /* =====================================
       8. STOCK SUMMARY
    ===================================== */
    console.log("Syncing Stock Summary...");
    await api.get("/api/sync/stock-group-summary-sync", {
      params: { company }
    });
    console.log("Stock Summary Synced");
    await delay(3000);

    /* =====================================
       9. UNITS
    ===================================== */
    console.log("Syncing Units...");
    await api.get("/api/sync/units-sync", {
      params: { company }
    });
    console.log("Units Synced");
    await delay(3000);

    /* =====================================
       10. PURCHASE / SALES LEDGERS
    ===================================== */
    console.log("Syncing Purchase/Sales Ledgers...");
    await api.get("/api/sync/purchase-sales-ledgers-sync", {
      params: { company }
    });
    console.log("Purchase/Sales Ledgers Synced");
    await delay(3000);

    /* =====================================
       11. GODOWNS
    ===================================== */
    console.log("Syncing Godowns...");
    await api.get("/api/sync/godown-sync", {
      params: { company }
    });
    console.log("Godowns Synced");
    await delay(3000);

    /* =====================================
       12. PROFIT LOSS
    ===================================== */
    console.log("Syncing Profit Loss...");
    await api.get("/api/sync/profit-loss-sync", {
      params: {
        company,
        fromDate: finalFromDate,
        toDate: finalToDate
      }
    });
    console.log("Profit Loss Synced");
    await delay(3000);

    /* =====================================
       UPDATE STATUS → COMPLETED
    ===================================== */
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

    console.log(`JOB COMPLETED: ${id}`);

  } catch (err) {
    console.log(`JOB FAILED: ${id}`);
    console.log("ERROR:", err.message);
    console.log("FAILED URL:", err.config?.url);
    console.log("FAILED PARAMS:", err.config?.params);
    console.log("STATUS:", err.response?.status);
    console.log("RESPONSE:", err.response?.data);

    await pool.query(
      `
      UPDATE ${DB_SCHEMA}.job_logs
      SET
        status = 'failed',
        error_message = $1,
        completed_at = NOW()
      WHERE id = $2
      `,
      [`${err.config?.url || "unknown-url"} | ${err.message}`, id]
    );

    // Re-throw for BullMQ retry mechanism
    throw err;
  }
}

/* ===================================================
   BULLMQ WORKER
=================================================== */

const worker = new Worker(
  SYNC_QUEUE_NAME,
  async (job) => {
    return await processJob(job);
  },
  {
    connection,
    concurrency: 1
  }
);

worker.on("completed", (job) => {
  console.log(`SYNC JOB COMPLETED: ${job.id}`);
});

worker.on("failed", async (job, err) => {
  console.error(`SYNC JOB FAILED: ${job?.id}`, err.message);
});

console.log("\n");
console.log("=====================================");
console.log("SYNC WORKER STARTED (BULLMQ)");
console.log("=====================================");