/* ===================================================
   SYNC WORKER
=================================================== */

import axios from "axios";

import pool from "../db/index.js";

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

  baseURL:
    "http://localhost:5000",

  timeout:
    300000

});

/* ===================================================
   PROCESS JOB
=================================================== */

async function processJob(job) {

  const {

    id,

    payload

  } = job;

  try {

    console.log("\n");

    console.log(
      "====================================="
    );

    console.log(
      `PROCESSING JOB ID: ${id}`
    );

    console.log(
      "====================================="
    );

    /* =====================================
       PAYLOAD
    ===================================== */

   const {

  company

} = payload;
/* =====================================
   FETCH FINANCIAL YEAR
===================================== */

const companyResult =

  await pool.query(

    `
    SELECT


  financial_year_start,
  financial_year_end

    FROM app_test.companies

    WHERE name = $1
    `,

    [company]

  );

const fromDate =

  companyResult.rows[0]
    ?.financial_year_start;

const toDate =

  companyResult.rows[0]
    ?.financial_year_end;
    const finalFromDate =
  `${fromDate}0401`;

const finalToDate =
  `${toDate}0331`;

if (!fromDate || !toDate) {

  throw new Error(
    `Financial year not found for ${company}`
  );

}

    console.log(
      `Company: ${company}`
    );

    /* =====================================
       LEDGER SYNC
    ===================================== */

    console.log(
      "Syncing Ledgers..."
    );

    await api.get(

      "/api/sync/ledgers",

      {
        params: {
          company
        }
      }

    );

    console.log(
      "Ledgers Synced"
    );

    await delay(3000);

    /* =====================================
       VOUCHER SYNC
    ===================================== */

    console.log(
      "Syncing Vouchers..."
    );

    await api.get(

      "/api/sync/voucher-sync",

      {
       params: {

  company,

  fromDate: finalFromDate,

  toDate: finalToDate

}
      }

    );

    console.log(
      "Vouchers Synced"
    );

    await delay(5000);

    /* =====================================
       CREDITORS
    ===================================== */

    console.log(
      "Syncing Creditors..."
    );

    await api.get(

      "/api/sync/group-summary-cr",

      {
        params: {
          company
        }
      }

    );

    console.log(
      "Creditors Synced"
    );

    await delay(3000);

    /* =====================================
       DEBTORS
    ===================================== */

    console.log(
      "Syncing Debtors..."
    );

    await api.get(

      "/api/sync/group-summary-dr",

      {
        params: {
          company
        }
      }

    );

    console.log(
      "Debtors Synced"
    );

    await delay(3000);

    /* =====================================
       BANKS
    ===================================== */

    console.log(
      "Syncing Banks..."
    );

    await api.get(

      "/api/sync/group-summary-bank",

      {
        params: {
          company
        }
      }

    );

    console.log(
      "Banks Synced"
    );

    await delay(3000);

    /* =====================================
       PARENT GROUPS
    ===================================== */

    console.log(
      "Syncing Parent Groups..."
    );

    const parentGroupsResponse =

      await api.get(

        "/api/sync/parent-groups",

        {
          params: {
            company
          }
        }

      );

    console.log(
      "Parent Groups Synced"
    );

    await delay(3000);

    /* =====================================
       ALL PARENT GROUPS
    ===================================== */

    const parentGroups =

      parentGroupsResponse?.data
        ?.data || [];

    for (const group of parentGroups) {

      try {

        const groupName =
          group?.group_name;

        if (!groupName) {

          continue;

        }

        console.log(
          `Syncing Group: ${groupName}`
        );

        await api.get(

          "/api/sync/all-parent-groups",

          {
            params: {

              company,

              groupName

            }
          }

        );

        console.log(
          `${groupName} Synced`
        );

        await delay(3000);

      } catch (groupError) {

        console.log(
          `Group Failed: ${groupError.message}`
        );

      }

    }

    /* =====================================
       STOCK SUMMARY
    ===================================== */

    console.log(
      "Syncing Stock Summary..."
    );

    await api.get(

      "/api/sync/stock-group-summary-sync",

      {
        params: {
          company
        }
      }

    );

    console.log(
      "Stock Summary Synced"
    );

    await delay(3000);

    /* =====================================
       PROFIT LOSS
    ===================================== */

    console.log(
      "Syncing Profit Loss..."
    );

    await api.get(

      "/api/sync/profit-loss-sync",

      {
      params: {

  company,

  fromDate: finalFromDate,

  toDate: finalToDate

}
      }

    );

    console.log(
      "Profit Loss Synced"
    );

    await delay(3000);

    /* =====================================
       UPDATE STATUS → COMPLETED
    ===================================== */

    await pool.query(

      `
      UPDATE app_test.job_logs

      SET

        status = 'completed',

        completed_at = NOW()

      WHERE id = $1
      `,

      [id]

    );

    console.log(
      `JOB COMPLETED: ${id}`
    );

  } catch (err) {

    console.log(
      `JOB FAILED: ${id}`
    );

    console.log(
      err.message
    );

    /* =====================================
       UPDATE STATUS → FAILED
    ===================================== */

    await pool.query(

      `
      UPDATE app_test.job_logs

      SET

        status = 'failed',

        error_message = $1,

        completed_at = NOW()

      WHERE id = $2
      `,

      [
        err.message,
        id
      ]

    );

  }

}

/* ===================================================
   WORKER LOOP
=================================================== */

async function startWorker() {

  console.log("\n");

  console.log(
    "====================================="
  );

  console.log(
    "SYNC WORKER STARTED"
  );

  console.log(
    "====================================="
  );

  while (true) {

    try {

      /* =====================================
         FETCH + LOCK PENDING JOB
      ===================================== */

      const result =

        await pool.query(

          `
          UPDATE app_test.job_logs

          SET

            status = 'running',

            started_at = NOW()

          WHERE id = (

            SELECT id

            FROM app_test.job_logs

            WHERE status = 'pending'

            ORDER BY id ASC

            LIMIT 1

            FOR UPDATE SKIP LOCKED

          )

          RETURNING *
          `

        );

      const job =
        result.rows[0];

      /* =====================================
         NO JOB
      ===================================== */

      if (!job) {

        await delay(5000);

        continue;

      }

      /* =====================================
         PROCESS JOB
      ===================================== */

      await processJob(job);

    } catch (err) {

      console.log(
        "WORKER ERROR:"
      );

      console.log(
        err.message
      );

      await delay(5000);

    }

  }

}

/* ===================================================
   START WORKER
=================================================== */

startWorker();