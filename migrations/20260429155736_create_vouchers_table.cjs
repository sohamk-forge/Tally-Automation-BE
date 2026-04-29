exports.up = function(knex) {
  return knex.schema.createTable('vouchers', function(table) {
    table.increments('id').primary();
    table.string('company_name');
    table.string('voucher_type');
    table.string('voucher_number');
    table.string('voucher_date');
    table.string('party_name');
    table.decimal('amount', 12, 2);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('vouchers');
};