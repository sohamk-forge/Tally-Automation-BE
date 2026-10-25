export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("quotation_items", (table) => {
      table.text("narration");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("quotation_items", (table) => {
      table.dropColumn("narration");
    });
}
