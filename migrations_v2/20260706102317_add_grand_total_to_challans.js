export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("challans", (table) => {
    table.decimal("grand_total", 18, 2).defaultTo(0);
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("challans", (table) => {
    table.dropColumn("grand_total");
  });
}