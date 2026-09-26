export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("stock_group_summary", (table) => {
      table.decimal("cgst_rate", null)
        .notNullable()
        .defaultTo(0);

      table.decimal("sgst_rate", null)
        .notNullable()
        .defaultTo(0);

      table.decimal("igst_rate", null)
        .notNullable()
        .defaultTo(0);
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("stock_group_summary", (table) => {
      table.dropColumn("cgst_rate");
      table.dropColumn("sgst_rate");
      table.dropColumn("igst_rate");
    });
}