exports.up = function(knex) {
  return knex.schema.createTable('sync_logs', function(table) {
    table.increments('id').primary();
    table.string('module_name');
    table.string('status');
    table.text('message');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('sync_logs');
};