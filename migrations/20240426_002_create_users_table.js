exports.up = function(knex) {
  return knex.schema.withSchema('app').createTable('users', (table) => {
    table.increments('id').primary();
    table.text('email').unique().notNullable();
    table.text('password').notNullable();
    table.enum('role', ['admin', 'accountant', 'warehouse', 'viewer']).notNullable();
    table.timestamps(true, true); // created_at, updated_at with default CURRENT_TIMESTAMP
  });
};

exports.down = function(knex) {
  return knex.schema.withSchema('app').dropTableIfExists('users');
};

