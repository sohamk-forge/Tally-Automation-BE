/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.withSchema('app').table('job_logs', (table) => {
    table.integer('user_id').unsigned().nullable()
      .references('id')
      .inTable('app.users')
      .onDelete('CASCADE');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.withSchema('app').table('job_logs', (table) => {
    table.dropColumn('user_id');
  });
};