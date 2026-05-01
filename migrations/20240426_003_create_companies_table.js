exports.up = function(knex) {
  return knex.schema.withSchema('app').createTable('companies', (table) => {
    table.increments('id').primary();
    table.text('name').notNullable();
    table.text('tally_company_name').notNullable();
    table.timestamps(true, true);
  });
};

exports.down = function(knex) {
  return knex.schema.withSchema('app').dropTableIfExists('companies');
};
