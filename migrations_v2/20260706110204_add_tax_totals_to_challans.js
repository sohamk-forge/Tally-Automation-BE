export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("challans", (table) => {
    table.decimal("sub_total", 18, 2).defaultTo(0);
    table.decimal("total_cgst", 18, 2).defaultTo(0);
    table.decimal("total_sgst", 18, 2).defaultTo(0);
    table.decimal("total_igst", 18, 2).defaultTo(0);
    table.decimal("total_tax", 18, 2).defaultTo(0);
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("challans", (table) => {
    table.dropColumn("sub_total");
    table.dropColumn("total_cgst");
    table.dropColumn("total_sgst");
    table.dropColumn("total_igst");
    table.dropColumn("total_tax");
  });
}