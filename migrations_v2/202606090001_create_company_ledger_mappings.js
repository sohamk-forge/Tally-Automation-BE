export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("company_ledger_mappings", (table) => {

      table.increments("id").primary();

      table.integer("company_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.string("invoice_parent_group");

      table.string("cgst_ledger");

      table.string("sgst_ledger");

      table.string("igst_ledger");

      table.string("tds_ledger");

      table.string("cess_ledger");

      table.string("rounded_off_ledger");

      table.timestamps(true, true);

      table.unique(["company_id"]);
    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("company_ledger_mappings");

}