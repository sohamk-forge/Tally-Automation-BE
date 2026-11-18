import "dotenv/config";

import app from "./app.js";
import pool from "./db/index.js";
import { resumeExtractionJobs } from "./services/statementExtraction.js";
import { backfillGroupKeyEmbeddings } from "./services/ledgerEmbedding.js";

const PORT = process.env.PORT || 5001;

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  resumeExtractionJobs();
  backfillGroupKeyEmbeddings().catch((err) =>
    console.error("group key embedding backfill failed:", err.message)
  );
});

let shuttingDown = false;

async function closeDbPool() {
  try {
    await pool.end();
    console.log("DB pool closed");
  } catch (err) {
    console.error("DB pool close failed:", err.message);
  }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Shutting down...`);

  // Never hang a restart (nodemon/pm2) on a stuck keep-alive socket or pool.
  setTimeout(() => process.exit(1), 8000).unref();

  server.close(async (error) => {
    if (error) {
      console.error(
        "HTTP server shutdown failed:",
        error
      );
    } else {
      console.log("HTTP server closed");
    }

    // Close DB connections cleanly so the server doesn't keep orphaned
    // backends around after every restart.
    await closeDbPool();
    process.exit(error ? 1 : 0);
  });
  server.closeIdleConnections?.();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Backstop, not a fix — every worker (invoice push, purchase push, stock
// item push, bulk sales, bank sync, ...) is imported into this same
// process (app.js), so without this, one uncaught throw anywhere (e.g. the
// double pg client.release() that used to live in connector.routes.js)
// takes down every in-flight sync for every company, silently, until
// someone notices and restarts. Log and stay up instead.
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION] Backend stayed up. Reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[UNCAUGHT EXCEPTION] Backend stayed up. Error:", error);
});