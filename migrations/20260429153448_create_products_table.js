export async function up(knex) {
  await knex.schema.createTable('products', (table) => {
    table.increments('id').primary();
    table.string('name');
    table.decimal('price');
    table.integer('qty');
    table.timestamps(true, true);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('products');
}