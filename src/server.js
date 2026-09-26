import "dotenv/config";

import app from "./app.js";
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

function shutdown(signal) {
  console.log(`${signal} received. Shutting down...`);

  server.close((error) => {
    if (error) {
      console.error(
        "HTTP server shutdown failed:",
        error
      );

      process.exit(1);
    }

    console.log("HTTP server closed");
    process.exit(0);
  });
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