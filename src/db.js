import knex from "knex";
import knexConfig from "../knexfile.js";

// Use development or production config
const environment = process.env.NODE_ENV || "development";

const config = knexConfig[environment];

const db = knex(config);

// Test connection
db.raw("SELECT 1")
  .then(() => {
    console.log("✅ Database connected successfully");
  })
  .catch((error) => {
    console.error(
      "❌ Database connection failed:",
      error.message
    );
    process.exit(1);
  });

export default db;