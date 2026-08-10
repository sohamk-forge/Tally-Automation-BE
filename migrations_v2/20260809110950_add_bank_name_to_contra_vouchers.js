export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("contra_vouchers", (table) => {
      table
        .string("bank_name")
        .comment("Selected bank from the fixed dropdown (e.g. 'HDFC Bank') — used to validate the uploaded statement actually belongs to this bank. Distinct from bank_ledger, which is the free-form Tally ledger account name.");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("contra_vouchers", (table) => {
      table.dropColumn("bank_name");
    });
}