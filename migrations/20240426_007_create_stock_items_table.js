exports.up = function(knex) {
  return knex.schema.withSchema('app').createTable('stock_items', (table) => {
    table.increments('id').primary();
    table.integer('company_id').unsigned().notNullable()
      .references('id').inTable('app.companies').onDelete('CASCADE');
    table.text('tally_stock_id').unique();
    table.text('name');
    table.text('unit');
    table.decimal('closing_balance', 15, 2);
    table.bigInteger('alter_id');
    table.timestamps(true, true);
    
    // Index
    table.index('company_id', 'idx_stock_company');
  });
};

exports.down = function(knex) {
  return knex.schema.withSchema('app').dropTableIfExists('stock_items');
};
