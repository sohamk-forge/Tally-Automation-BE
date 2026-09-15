import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "tally_dashboard",
  max: 20,                          // was 5 — too low for bulk workloads
  min: 2,                           // keep warm connections ready
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,   // was 2000 — too tight under load
  allowExitOnIdle: false
});

// Retries with backoff instead of exiting on the first attempt — a DB that
// just restarted/failed over can report "the database system is in
// recovery mode" or ECONNRESET for a short window before it's actually
// ready to accept connections. Exiting immediately on that first blip just
// forces nodemon into a restart loop that keeps re-racing the same
// not-yet-ready DB. Still fails fast overall — it gives up after the
// retries are exhausted, same as before.
async function verifyDbConnection(retries = 5, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const client = await pool.connect();
      console.log("✅ PostgreSQL Connected Successfully");
      client.release();
      return;
    } catch (err) {
      console.error(`❌ DB Connection Error (attempt ${attempt}/${retries}):`, err.message);

      if (attempt === retries) {
        console.error(`DB still unreachable after ${retries} attempts — exiting.`);
        process.exit(1);
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

verifyDbConnection();

export default pool;