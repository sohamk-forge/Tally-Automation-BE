import "dotenv/config";

import app from "./app.js";

const PORT = process.env.PORT || 5001;

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
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