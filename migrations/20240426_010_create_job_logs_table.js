exports.up = function(knex) {
  return knex.schema.withSchema('app').createTable('job_logs', (table) => {
    table.increments('id').primary();
    table.text('job_type');
    table.enum('status', ['pending', 'success', 'failed']).notNullable();
    table.jsonb('payload');
    table.text('error_message');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = function(knex) {
  return knex.schema.withSchema('app').dropTableIfExists('job_logs');
};
