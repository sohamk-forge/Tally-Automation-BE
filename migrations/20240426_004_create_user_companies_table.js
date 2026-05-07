exports.up = function(knex) {
  return knex.schema.withSchema('app').createTable('user_companies', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable()
      .references('id').inTable('app.users').onDelete('CASCADE');
    table.integer('company_id').unsigned().notNullable()
      .references('id').inTable('app.companies').onDelete('CASCADE');
    table.unique(['user_id', 'company_id']);
  });
};

exports.down = function(knex) {
  return knex.schema.withSchema('app').dropTableIfExists('user_companies');
};
