export async function up(knex) {
  await knex.schema.withSchema('app').createTable('voucher_entries', (table) => {
    table.increments('id').primary();
    table.integer('voucher_id').unsigned().notNullable()
      .references('id').inTable('app.vouchers').onDelete('CASCADE');
    table.text('ledger_name');
    table.decimal('debit_amount', 15, 2).defaultTo(0);
    table.decimal('credit_amount', 15, 2).defaultTo(0);
    
    // Index
    table.index('voucher_id', 'idx_entries_voucher');
  });
};

export async function down(knex) {
  await knex.schema.withSchema('app').dropTableIfExists('voucher_entries');
};
