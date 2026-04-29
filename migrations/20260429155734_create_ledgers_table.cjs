exports.up = function(knex) {
  return knex.schema.createTable('ledgers', function(table) {
    table.increments('id').primary();
    table.string('company_name');
    table.string('ledger_name');
    table.string('parent_group');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('ledgers');
};