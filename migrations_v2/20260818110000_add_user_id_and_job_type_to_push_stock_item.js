/**
 * Same insert-then-enqueue race as push_bank / sales_invoice_extractions
 * (see those migrations for the full rationale) — push_stock_item has no
 * user_id, so a row orphaned by a backend restart between DB write and
 * Redis enqueue has no safe way to be recovered on startup.
 *
 * push_stock_item is unusual: it's shared by TWO independent push flows —
 * "create" (pushStockItem.routes.js, bulkStockItem.worker.js, queue
 * stock-item-push) and "alter" (pushStockItemOpening.routes.js, the
 * auto-chain in connector.routes.js, queue alter-stock-item-push) — both
 * converging on the same status column. pending_job_type records which
 * queue a 'pending' row belongs to, so a startup recovery sweep can
 * re-enqueue it to the correct one instead of guessing.
 */

export async function up(knex) {
  await knex.schema.withSchema("app_test").alterTable("push_stock_item", (table) => {
    table.integer("user_id").references("id").inTable("app_test.users");
    table.string("pending_job_type"); // 'create' | 'alter' — set whenever status is written to 'pending'
  });
}

export async function down(knex) {
  await knex.schema.withSchema("app_test").alterTable("push_stock_item", (table) => {
    table.dropColumn("user_id");
    table.dropColumn("pending_job_type");
  });
}
