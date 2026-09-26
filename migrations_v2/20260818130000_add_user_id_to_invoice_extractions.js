/**
 * Same gap as push_bank / sales_invoice_extractions — invoice_extractions
 * (purchase invoices) has no user_id, so a row orphaned by a backend
 * restart between insert and enqueue has no safe way to be recovered on
 * startup.
 */

export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("invoice_extractions", (table) => {
    table.integer("user_id").references("id").inTable("app_test.users");
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("invoice_extractions", (table) => {
    table.dropColumn("user_id");
  });
}
