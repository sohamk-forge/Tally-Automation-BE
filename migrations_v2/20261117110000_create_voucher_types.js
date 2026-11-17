// Voucher types synced from Tally (one row per company + type name), plus the
// per-voucher Tally type name chosen in the UI. `voucher_type` on
// contra_vouchers stays the BASE type (payment/receipt/contra) and keeps
// driving ledger direction; `voucher_type_name` only changes the XML header.
export async function up(knex) {
  await knex.schema.withSchema("app_test").createTable("voucher_types", (table) => {
    table.bigIncrements("id").primary();
    table.integer("company_id").unsigned().notNullable();
    table.foreign("company_id").references("id").inTable("app_test.companies").onDelete("CASCADE");
    table.text("company_name");
    table.text("name").notNullable();
    table.text("parent");
    // Root built-in type after walking the PARENT chain (e.g. "Receipt"); lower-case.
    table.text("base_type");
    table.boolean("is_active").defaultTo(true);
    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.timestamp("updated_at").defaultTo(knex.fn.now());
  });

  await knex.raw(
    `CREATE UNIQUE INDEX voucher_types_company_name_uq
       ON app_test.voucher_types (company_id, LOWER(TRIM(name)))`
  );

  await knex.schema.withSchema("app_test").alterTable("contra_vouchers", (table) => {
    table.text("voucher_type_name");
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("contra_vouchers", (table) => {
    table.dropColumn("voucher_type_name");
  });
  await knex.schema.withSchema("app_test").dropTableIfExists("voucher_types");
}
