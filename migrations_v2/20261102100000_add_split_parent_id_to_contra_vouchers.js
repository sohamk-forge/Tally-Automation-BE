/**
 * Backs "split a transaction" on the Review Statement page: one bank row is
 * divided into 2+ rows whose amounts add up to the original. The original
 * stays in the table with status 'SPLIT' (so a statement re-upload still
 * recognises it and an undo can restore it); each part is an ordinary
 * WAITING_LEDGER row pointing back at it through split_parent_id.
 * NULL = row is not a split part.
 */

export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("contra_vouchers", (table) => {
    table
      .bigInteger("split_parent_id")
      .nullable()
      .references("id")
      .inTable("app_test.contra_vouchers")
      .onDelete("CASCADE");
  });

  await knex.raw(`
    CREATE INDEX idx_app_test_contra_vouchers_split_parent_id
    ON app_test.contra_vouchers (split_parent_id)
    WHERE split_parent_id IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS app_test.idx_app_test_contra_vouchers_split_parent_id`);

  await knex.schema.withSchema("app_test").alterTable("contra_vouchers", (table) => {
    table.dropColumn("split_parent_id");
  });
}
