exports.up = function(knex) {
  return knex.schema.withSchema('app').createTable('ledgers', (table) => {
    table.increments('id').primary();
    table.integer('company_id').unsigned().notNullable()
      .references('id').inTable('app.companies').onDelete('CASCADE');
    table.text('tally_ledger_id').unique();
    table.text('name');
    table.text('group_name');
    table.bigInteger('alter_id');
    table.timestamps(true, true);
    
    // Index
    table.index('company_id', 'idx_ledgers_company');
  });
};

exports.down = function(knex) {
  return knex.schema.withSchema('app').dropTableIfExists('ledgers');
};
