export async function up(knex) {
  await knex.schema.withSchema('app').createTable('user_companies', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable()
      .references('id').inTable('app.users').onDelete('CASCADE');
    table.integer('company_id').unsigned().notNullable()
      .references('id').inTable('app.companies').onDelete('CASCADE');
    table.unique(['user_id', 'company_id']);
  });
};

export async function down(knex) {
  await knex.schema.withSchema('app').dropTableIfExists('user_companies');
};
