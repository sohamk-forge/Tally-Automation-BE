import pkg from "pg";
const { Pool } = pkg;

console.log("DB USER =", process.env.DB_USER);
console.log("DB NAME =", process.env.DB_NAME);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

export default pool;