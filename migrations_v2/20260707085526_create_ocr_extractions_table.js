export async function up(knex) {
  await knex.schema.withSchema('app_test').createTable('ocr_extractions', (table) => {
    table.increments('id').primary();
    table.text('company_name').notNullable();
    table.integer('company_id');
    table.jsonb('raw_ocr_response').notNullable();
    table.text('status').notNullable().defaultTo('pending'); // pending | processing | done | error
    table.jsonb('validation_result');
    table.text('error_message');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.withSchema('app_test').alterTable('ocr_extractions', (table) => {
    table.index('status', 'idx_ocr_extractions_status');
  });
}

export async function down(knex) {
  await knex.schema.withSchema('app_test').dropTableIfExists('ocr_extractions');
}