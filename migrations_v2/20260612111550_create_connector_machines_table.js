export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("connector_machines", (table) => {

      table.increments("id").primary();

      table.string("machine_id")
        .notNullable()
        .unique();

      table.string("machine_name");

      table.string("os_name");

      table.string("connector_version");

      table.boolean("tally_connected")
        .defaultTo(false);

      table.timestamp("last_seen");

      table.timestamps(true, true);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("connector_machines");

}