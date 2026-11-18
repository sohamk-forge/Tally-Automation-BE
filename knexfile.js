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
        process.env.DB_PORT || 5431,

      user:
        process.env.DB_USER ||
        "postgres",

      password:
        process.env.DB_PASSWORD,

      database:
        process.env.DB_NAME ||
        "tally_dashboard",

      // Detect dead peers so the server can drop half-open connections, and
      // make this process identifiable in pg_stat_activity.
      keepAlive: true,
      application_name: "tally-be-knex",

    },

  migrations: {

  directory: "./migrations_v2",

  extension: "js",

  tableName: "knex_migrations_v2"

},

    seeds: {

      directory: "./seeds",

      extension: "js",

    },

    pool: {

      min: 0,

      max: Number(process.env.KNEX_POOL_MAX) || 3,

      idleTimeoutMillis: 10000,

    },

  },

};
