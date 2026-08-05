import dotenv from "dotenv";

dotenv.config();

export default {

  development: {

    client: "pg",

    connection: {

      host:
        process.env.DB_HOST ||
        "127.0.0.1",

      port:
        process.env.DB_PORT || 5432,

      user:
        process.env.DB_USER ||
        "postgres",

      password:
        process.env.DB_PASSWORD,

      database:
        process.env.DB_NAME ||
        "tally_dashboard",

    },

  migrations: {

  directory: "./migrations_v2",

  extension: "js",

  tableName: "knex_migrations_v2",

  // Without this, the tracking table lives in `public` and is shared across
  // every DB_SCHEMA value — a fresh schema would be treated as "already
  // migrated" (since the same table says so) and nothing would get created.
  schemaName: process.env.DB_SCHEMA || "app_test"

},

    seeds: {

      directory: "./seeds",

      extension: "js",

    },

    pool: {

      min: 1,

      max: 5,

    },

  },

};