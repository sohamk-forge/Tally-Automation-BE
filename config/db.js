const knex = require('knex');
require('dotenv').config();

const db = knex({
  client: 'pg',
  connection: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: false,
    keepAlive: true,
    application_name: 'tally-be-knex',
  },
  pool: {
    min: 0,
    max: Number(process.env.KNEX_POOL_MAX) || 3,
    idleTimeoutMillis: 10000,
  },
});

module.exports = db;