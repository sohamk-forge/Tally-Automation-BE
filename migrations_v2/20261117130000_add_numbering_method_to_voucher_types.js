// Tally's "Method of Voucher Numbering" per voucher type: Automatic,
// Automatic (Manual Override) or Manual. Only plain Automatic types number
// themselves on XML import; the others need a VOUCHERNUMBER in the push.
export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("voucher_types", (table) => {
    table.text("numbering_method");
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("voucher_types", (table) => {
    table.dropColumn("numbering_method");
  });
}
