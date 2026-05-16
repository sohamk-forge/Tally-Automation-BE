export async function up(knex) {
  await knex.schema.createTable('sync_logs', (table) => {
    table.increments('id').primary();
    table.string('module_name');
    table.string('status');
    table.text('message');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('sync_logs');
}