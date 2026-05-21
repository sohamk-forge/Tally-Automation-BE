import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "tally_dashboard",
  max: 5, // limit connections (faster)
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection once
pool.connect()
  .then(client => {
    console.log("✅ PostgreSQL Connected Successfully");
    client.release();
  })
  .catch(err => {
    console.error("❌ DB Connection Error:", err.message);
  });

export default pool;