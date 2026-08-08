export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("challans", (table) => {
      table.string("challan_type").defaultTo("Delivery Challan");
      table.string("supply_type").defaultTo("intrastate");
    });

  await knex.schema
    .withSchema("app_test")
    .alterTable("challan_items", (table) => {
      table.string("unit");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("challans", (table) => {
      table.dropColumn("challan_type");
      table.dropColumn("supply_type");
    });

  await knex.schema
    .withSchema("app_test")
    .alterTable("challan_items", (table) => {
      table.dropColumn("unit");
    });
}