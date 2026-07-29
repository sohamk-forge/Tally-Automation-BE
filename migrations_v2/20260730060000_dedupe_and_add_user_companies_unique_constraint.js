export async function up(knex) {
  // Keep the lowest id per (user_id, company_id) pair, drop the rest
  await knex.raw(`
    DELETE FROM app_test.user_companies a
    USING app_test.user_companies b
    WHERE a.user_id = b.user_id
      AND a.company_id = b.company_id
      AND a.id > b.id
  `);

  await knex.schema
    .withSchema("app_test")
    .alterTable("user_companies", (table) => {
      table.unique(["user_id", "company_id"]);
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("user_companies", (table) => {
      table.dropUnique(["user_id", "company_id"]);
    });
}
