export async function up(knex) {

  await knex.schema
    .withSchema("app_test")
    .createTable("vouchers", (table) => {

      table.increments("id").primary();

      table.string("company_name");

      table.date("voucher_date");

      table.string("voucher_type");

      table.string("voucher_number");

      table.string("party_ledger_name");

      table.text("narration");

      table.timestamps(true, true);

      table.decimal("debit_amount", 18, 2)
        .defaultTo(0);

      table.decimal("credit_amount", 18, 2)
        .defaultTo(0);

      table.decimal("balance", 18, 2)
        .defaultTo(0);

      table.string("parent_group");

      table.string("guid");

      table.bigInteger("master_id");

      table.bigInteger("alter_id");

      table.integer("company_id")
        .unsigned()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.jsonb("ledger_entries");

    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("vouchers");

}