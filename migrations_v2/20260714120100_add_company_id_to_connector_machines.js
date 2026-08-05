import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("connector_machines", (table) => {

      table.integer("company_id")
        .unsigned();

      table.foreign("company_id")
        .references("id")
        .inTable(`${DB_SCHEMA}.companies`)
        .onDelete("SET NULL");

    });

  await knex.raw(`
    UPDATE ${DB_SCHEMA}.connector_machines cm
    SET company_id = c.id
    FROM ${DB_SCHEMA}.companies c
    WHERE TRIM(cm.company_name) = TRIM(c.name)
      AND cm.company_id IS NULL
  `);

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("connector_machines", (table) => {

      table.index(["company_id"], "idx_connector_machines_company_id");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("connector_machines", (table) => {

      table.dropIndex(["company_id"], "idx_connector_machines_company_id");

    });

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("connector_machines", (table) => {

      table.dropForeign("company_id");
      table.dropColumn("company_id");

    });

}
