export async function up(knex) {
  await knex.schema
    .withSchema('app')
    .alterTable('companies', (table) => {
      table.dropColumn('tally_company_name');

      table.date('financial_year_start');
      table.date('financial_year_end');
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema('app')
    .alterTable('companies', (table) => {
      table.text('tally_company_name');

      table.dropColumn('financial_year_start');
      table.dropColumn('financial_year_end');
    });
}