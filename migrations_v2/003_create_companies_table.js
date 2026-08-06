export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("companies", (table) => {

      table.increments("id").primary();

      table.string("name")
        .notNullable()
        .unique();

      table.timestamps(true, true);

   table.string("financial_year_start");

table.string("financial_year_end");

      table.string("guid");

      table.bigInteger("master_id");

      table.bigInteger("alter_id");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("companies");

}