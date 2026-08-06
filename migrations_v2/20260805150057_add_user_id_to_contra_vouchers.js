// migrations/xxxxxx_add_user_id_to_contra_vouchers.js
export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("contra_vouchers", (table) => {
      table.integer("user_id");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("contra_vouchers", (table) => {
      table.dropColumn("user_id");
    });
}