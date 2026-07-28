export async function up(knex) {

    await knex.schema
        .withSchema("app_test")
        .table("company_ledger_mappings", (table) => {

            // Add sales_ledger column
            // This stores the actual Tally ledger name (e.g. "Sales @18%")
            // NOT a hardcoded fallback like "Sales"
            table.string("sales_ledger", 255)
                .nullable()
                .defaultTo(null);

        });

}

export async function down(knex) {

    await knex.schema
        .withSchema("app_test")
        .table("company_ledger_mappings", (table) => {

            table.dropColumn("sales_ledger");

        });

}
