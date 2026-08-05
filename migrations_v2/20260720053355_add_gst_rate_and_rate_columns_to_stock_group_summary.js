import { DB_SCHEMA } from "../src/config/db.js";

// The following migration (20260720053356) alters these columns' precision
// via knex's .alter(), which requires them to already exist. They were
// originally added directly against app_test without a migration ever being
// committed for it — this backfills that missing step so a fresh schema can
// replay history correctly. Types match what 20260720053356's down()
// reverts to, i.e. what they were before that migration ran.
export async function up(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("stock_group_summary", (table) => {
      table.decimal("gst_rate", 5, 2)
        .notNullable()
        .defaultTo(0);

      table.decimal("rate", 15, 2)
        .notNullable()
        .defaultTo(0);
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("stock_group_summary", (table) => {
      table.dropColumn("gst_rate");
      table.dropColumn("rate");
    });
}
