export async function up(knex) {
  await knex.schema.withSchema('app').createTable('vouchers', (table) => {
    table.increments('id').primary();
    table.integer('company_id').unsigned().notNullable()
      .references('id').inTable('app.companies').onDelete('CASCADE');
    table.text('tally_voucher_id').unique();
    table.text('voucher_type');
    table.date('voucher_date');
    table.text('party_ledger_name');
    table.decimal('amount', 15, 2);
    table.bigInteger('alter_id');
    table.jsonb('raw');
    table.timestamps(true, true);
    
    // Indexes
    table.index('company_id', 'idx_vouchers_company');
    table.index('voucher_date', 'idx_vouchers_date');
    table.index('alter_id', 'idx_vouchers_alter');
  });
};

export async function down(knex) {
  await knex.schema.withSchema('app').dropTableIfExists('vouchers');
};
