export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("company_details", (table) => {

      table.boolean("gst_enabled")
        .notNullable()
        .defaultTo(false);

      table.string("gst_registration_type");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("company_details", (table) => {

      table.dropColumn("gst_enabled");
      table.dropColumn("gst_registration_type");

    });

}