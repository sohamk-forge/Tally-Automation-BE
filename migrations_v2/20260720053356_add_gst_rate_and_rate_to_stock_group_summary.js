export async function up(knex) {
  // gst_rate/rate were added directly on the remote DB outside of migrations
  // at some point, so this migration originally only ever needed to widen an
  // existing column. On a fresh database (no out-of-band column) that .alter()
  // fails since the column never existed — so add it here if missing, alter
  // it in place otherwise. Same end state either way.
  const hasGstRate = await knex.schema
    .withSchema("app_test")
    .hasColumn("stock_group_summary", "gst_rate");

  const hasRate = await knex.schema
    .withSchema("app_test")
    .hasColumn("stock_group_summary", "rate");

  await knex.schema
    .withSchema("app_test")
    .alterTable("stock_group_summary", (table) => {
      if (hasGstRate) {
        table.decimal("gst_rate", null).notNullable().defaultTo(0).alter();
      } else {
        table.decimal("gst_rate", null).notNullable().defaultTo(0);
      }

      if (hasRate) {
        table.decimal("rate", null).notNullable().defaultTo(0).alter();
      } else {
        table.decimal("rate", null).notNullable().defaultTo(0);
      }
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("stock_group_summary", (table) => {
      table.decimal("gst_rate", 5, 2)
        .notNullable()
        .defaultTo(0)
        .alter();

      table.decimal("rate", 15, 2)
        .notNullable()
        .defaultTo(0)
        .alter();
    });
}