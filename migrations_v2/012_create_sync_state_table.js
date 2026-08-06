export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("sync_state", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.bigInteger("last_voucher_alter_id")
        .defaultTo(0);

      table.bigInteger("last_master_alter_id")
        .defaultTo(0);

      table.timestamp("last_synced_at");

      table.string("company_name");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("sync_state");

}