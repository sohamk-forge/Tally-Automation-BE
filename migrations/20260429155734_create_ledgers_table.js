export async function up(knex) {
  await knex.schema.createTable('ledgers', (table) => {
    table.increments('id').primary();
    table.string('company_name');
    table.string('ledger_name');
    table.string('parent_group');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('ledgers');
}