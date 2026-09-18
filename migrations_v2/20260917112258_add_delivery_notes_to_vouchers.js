export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("vouchers", (table) => {
      table.jsonb("delivery_notes").defaultTo(knex.raw("'[]'::jsonb"));
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("vouchers", (table) => {
      table.dropColumn("delivery_notes");
    });
}