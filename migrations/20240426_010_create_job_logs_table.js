export async function up(knex) {
  await knex.schema.withSchema('app').createTable('job_logs', (table) => {
    table.increments('id').primary();
    table.text('job_type');
    table.enum('status', ['pending', 'success', 'failed']).notNullable();
    table.jsonb('payload');
    table.text('error_message');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

export async function down(knex) {
  await knex.schema.withSchema('app').dropTableIfExists('job_logs');
};
