export async function up(knex) {
  await knex.schema.withSchema('app').createTable('audit_logs', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().nullable()
      .references('id').inTable('app.users').onDelete('SET NULL');
    table.text('action');
    table.text('entity');
    table.integer('entity_id');
    table.jsonb('metadata');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

export async function down(knex) {
  await knex.schema.withSchema('app').dropTableIfExists('audit_logs');
};
