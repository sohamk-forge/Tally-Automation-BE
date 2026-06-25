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

pool.connect()
  .then(client => {
    console.log("✅ PostgreSQL Connected Successfully");
    client.release();
  })
  .catch(err => {
    console.error("❌ DB Connection Error:", err.message);
    process.exit(1); // fail fast on startup if DB is unreachable
  });

export default pool;