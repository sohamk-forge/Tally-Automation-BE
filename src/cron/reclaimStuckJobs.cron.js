import cron from "node-cron";
import pool from "../db/index.js";

import { DB_SCHEMA } from "../config/db.js";

/* =====================================
   RECLAIM STUCK CONNECTOR JOBS

   Any job a connector claimed (status='in_progress') but never
   reported a result for within 5 minutes (crash, lost connection,
   Tally hang) gets reset to 'pending' so the next poll can pick
   it up again.
===================================== */

cron.schedule("*/1 * * * *", async () => {
  try {

    const result = await pool.query(
      `
      UPDATE ${DB_SCHEMA}.job_logs
      SET status = 'pending', claimed_at = NULL
      WHERE status = 'in_progress'
        AND claimed_at < NOW() - INTERVAL '5 minutes'
      RETURNING id
      `
    );

    if (result.rowCount > 0) {
      console.log(`Reclaimed ${result.rowCount} stuck connector job(s)`);
    }

  } catch (err) {
    console.log("RECLAIM STUCK JOBS FAILED");
    console.log(err.message);
  }
});

console.log("Reclaim Stuck Jobs Cron Initialized");
