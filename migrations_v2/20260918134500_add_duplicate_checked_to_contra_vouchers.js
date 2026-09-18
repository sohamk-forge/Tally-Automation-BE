export async function up(knex) {
  const hasDuplicateChecked = await knex.schema.withSchema("app_test").hasColumn("contra_vouchers", "duplicate_checked");
  const hasDuplicateMessage = await knex.schema.withSchema("app_test").hasColumn("contra_vouchers", "duplicate_message");

  await knex.schema
    .withSchema("app_test")
    .alterTable("contra_vouchers", (table) => {
      if (!hasDuplicateChecked) table.boolean("duplicate_checked").defaultTo(false);
      if (!hasDuplicateMessage) table.text("duplicate_message");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("contra_vouchers", (table) => {
      table.dropColumn("duplicate_checked");
      table.dropColumn("duplicate_message");
    });
}
