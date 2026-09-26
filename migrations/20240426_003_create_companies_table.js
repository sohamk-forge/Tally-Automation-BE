export async function up(knex) {
  await knex.schema.withSchema('app').createTable('companies', (table) => {
    table.increments('id').primary();
    table.text('name').notNullable();
    table.text('tally_company_name').notNullable();
    table.timestamps(true, true);
  });
};

export async function down(knex) {
  await knex.schema.withSchema('app').dropTableIfExists('companies');
};
