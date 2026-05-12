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

      directory: "./migrations",

      extension: "js",

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