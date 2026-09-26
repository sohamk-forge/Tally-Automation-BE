export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("connector_api_keys", (table) => {

      table.increments("id").primary();

      table.bigInteger("user_id")
        .notNullable()
        .references("id")
        .inTable("app_test.users")
        .onDelete("CASCADE");

      table.string("machine_id").notNullable();

      table.string("key_hash").notNullable().unique();

      table.timestamp("created_at").defaultTo(knex.fn.now());

      table.timestamp("revoked_at").nullable();

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("connector_api_keys");

}
