export async function up(knex) {
  const hasForcePush = await knex.schema.withSchema("app_test").hasColumn("contra_vouchers", "force_push");

  await knex.schema
    .withSchema("app_test")
    .alterTable("contra_vouchers", (table) => {
      if (!hasForcePush) table.boolean("force_push").defaultTo(false);
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("contra_vouchers", (table) => {
      table.dropColumn("force_push");
    });
}
