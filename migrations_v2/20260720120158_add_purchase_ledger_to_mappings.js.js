export async function up(knex) {

    await knex.schema
        .withSchema("app_test")
        .table("company_ledger_mappings", (table) => {

            // Add purchase_ledger column
            // This stores the actual Tally ledger name (e.g. "Purchase @18%")
            // NOT the parent group (e.g. "Purchase Accounts")
            table.string("purchase_ledger", 255)
                .nullable()
                .defaultTo(null);

        });

}

export async function down(knex) {

    await knex.schema
        .withSchema("app_test")
        .table("company_ledger_mappings", (table) => {

            table.dropColumn("purchase_ledger");

        });

}