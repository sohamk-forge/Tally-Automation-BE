export async function up(knex) {
  const hasColumn = await knex.schema.withSchema("app").hasColumn("vouchers", "ledger_entries");
  if (hasColumn) {
    await knex.schema
      .withSchema("app")
      .alterTable("vouchers", (table) => {
        table.dropColumn("ledger_entries");
      });
  }
}

export async function down(knex) {
  const hasColumn = await knex.schema.withSchema("app").hasColumn("vouchers", "ledger_entries");
  if (!hasColumn) {
    await knex.schema
      .withSchema("app")
      .alterTable("vouchers", (table) => {
        table.jsonb("ledger_entries");
      });
  }
}