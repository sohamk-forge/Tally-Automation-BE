/**
 * Backs "club into one voucher" on the Review Statement page: several
 * same-date, same-side bank rows are pushed to Tally as ONE Payment /
 * Receipt voucher. Every row in the club shares this id; the lowest row id
 * in the group is the leader that owns the queue job (see
 * pushVoucher.worker.js). NULL = row is pushed on its own, as before.
 */

export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("contra_vouchers", (table) => {
    table.uuid("club_group_id").nullable();
  });

  await knex.raw(`
    CREATE INDEX idx_app_test_contra_vouchers_club_group_id
    ON app_test.contra_vouchers (club_group_id)
    WHERE club_group_id IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS app_test.idx_app_test_contra_vouchers_club_group_id`);

  await knex.schema.withSchema("app_test").alterTable("contra_vouchers", (table) => {
    table.dropColumn("club_group_id");
  });
}
