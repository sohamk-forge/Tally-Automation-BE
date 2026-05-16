export async function up(knex) {
  await knex.schema.createTable('vouchers', (table) => {
    table.increments('id').primary();
    table.string('company_name');
    table.string('voucher_type');
    table.string('voucher_number');
    table.string('voucher_date');
    table.string('party_name');
    table.decimal('amount', 12, 2);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('vouchers');
}