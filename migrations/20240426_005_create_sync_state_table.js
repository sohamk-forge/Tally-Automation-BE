export async function up(knex) {
  await knex.schema.withSchema('app').createTable('sync_state', (table) => {
    table.increments('id').primary();
    table.integer('company_id').unsigned().unique().notNullable()
      .references('id').inTable('app.companies').onDelete('CASCADE');
    table.bigInteger('last_voucher_alter_id').defaultTo(0);
    table.bigInteger('last_master_alter_id').defaultTo(0);
    table.timestamp('last_synced_at').nullable();
  });
};

export async function down(knex) {
  await knex.schema.withSchema('app').dropTableIfExists('sync_state');
};
