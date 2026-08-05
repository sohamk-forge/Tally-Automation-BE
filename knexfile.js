import dotenv from "dotenv";

dotenv.config();

// Same DB server/credentials for every environment below — only the target
// schema differs. Each environment gets its own migrations.schemaName, so
// its knex_migrations_v2 tracking table lives INSIDE that schema, isolated
// from every other schema's history (see knexfile schemaName comment below).
const connection = {

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

};

// Builds one knex environment config for a given target schema, so running
// against a different schema is `--env <name>` instead of editing DB_SCHEMA
// in .env and hoping nobody forgets to switch it back.
function makeEnv(schemaName) {

  return {

    client: "pg",

    connection,

    migrations: {

      directory: "./migrations_v2",

      extension: "js",

      tableName: "knex_migrations_v2",

      // Without this, the tracking table lives in `public` and is shared
      // across every schema — a fresh schema would be treated as "already
      // migrated" (since the same table says so) and nothing would get
      // created.
      schemaName,

    },

    seeds: {

      directory: "./seeds",

      extension: "js",

    },

    pool: {

      min: 1,

      max: 5,

    },

  };

}

export default {

  // Default: `npx knex migrate:latest` — still driven by DB_SCHEMA in .env,
  // unchanged behavior from before.
  development: makeEnv(process.env.DB_SCHEMA || "app_test"),

  // Explicit, dedicated targets: `npx knex migrate:latest --env app_test`
  // or `--env app_test_v1`. Add a new line here for each schema you want to
  // test against, instead of relying on switching DB_SCHEMA back and forth.
  app_test: makeEnv("app_test"),

  app_test_v1: makeEnv("app_test_v1"),

};