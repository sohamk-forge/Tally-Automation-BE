import cron from "node-cron";
import { reapExpiredConnectorJobs } from "../services/connectorJobClaim.service.js";
import { verifyUnknownConnectorJobs } from "../services/unknownJobVerifier.service.js";

/* =====================================
   CONNECTOR JOB LEASE REAPER

   Runs every minute for ALL connectors (the claim path only reaps the polling
   user's jobs, so a user whose connector stays off would otherwise never be
   cleaned up). A job whose lease lapsed becomes 'unknown' - never 'pending',
   because Tally may already have imported it - and is failed only after the
   grace period. See reapExpiredConnectorJobs.
===================================== */

cron.schedule("*/1 * * * *", async () => {
  try {
    await reapExpiredConnectorJobs();
  } catch (err) {
    console.error("CONNECTOR JOB REAPER FAILED:", err.message);
  }
  // Ask Tally about jobs whose result was lost, before the reaper's grace period fails them.
  try {
    await verifyUnknownConnectorJobs();
  } catch (err) {
    console.error("UNKNOWN JOB VERIFY FAILED:", err.message);
  }
});

console.log("Connector Job Reaper Cron Initialized");
