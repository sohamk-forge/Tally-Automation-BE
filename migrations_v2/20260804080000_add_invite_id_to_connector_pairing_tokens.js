export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("connector_pairing_tokens", (table) => {

      table.integer("invite_id")
        .unsigned()
        .references("id")
        .inTable("app_test.invites")
        .onDelete("CASCADE");

      table.index(["invite_id"]);

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("connector_pairing_tokens", (table) => {

      table.dropColumn("invite_id");

    });

}
