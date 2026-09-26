export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("invites", (table) => {
      table.string("role").notNullable().defaultTo("staff");
    });

  await knex.schema
    .withSchema("app_test")
    .raw(`
      ALTER TABLE app_test.invites
      ADD CONSTRAINT invites_role_check
      CHECK (role IN ('admin', 'accountant', 'staff'))
    `);

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("invites", (table) => {
      table.dropColumn("role");
    });

}
