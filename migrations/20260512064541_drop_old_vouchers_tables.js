export async function up(knex) {

  await knex.schema
    .withSchema("app")
    .dropTableIfExists(
      "voucher_entries"
    );

  await knex.schema
    .withSchema("app")
    .dropTableIfExists(
      "vouchers"
    );

}

export async function down(knex) {

  // Optional rollback

}