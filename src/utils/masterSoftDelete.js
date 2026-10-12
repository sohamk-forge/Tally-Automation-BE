// SQL fragments for the ledger / stock-item soft-delete (all_ledger_details
// and stock_group_summary.deleted_at, set by the full syncs in
// sync.routes.js when Tally no longer returns a master).
//
// Existence checks also trust push_ledger / push_stock_item rows with
// status 'success' (something this app created, possibly not synced back
// yet). Such a row stops counting once a sync has since marked the same
// name deleted — i.e. it was created, then removed from Tally afterwards.
// A push made AFTER that deletion (re-created) counts again.
//
// `alias` must be the push table's alias/name in the surrounding query.

export const normName = (expr) => `regexp_replace(LOWER(TRIM(${expr})), '\\s+', ' ', 'g')`;

export function pushedLedgerStillInTally(schema, alias) {
  return `NOT EXISTS (
      SELECT 1 FROM ${schema}.all_ledger_details d
      WHERE d.company_id = ${alias}.company_id
        AND LOWER(TRIM(d.ledger_name)) = LOWER(TRIM(${alias}.ledger_name))
        AND d.deleted_at > COALESCE(${alias}.updated_at, ${alias}.created_at)
    )`;
}

export function pushedStockItemStillInTally(schema, alias) {
  return `NOT EXISTS (
      SELECT 1 FROM ${schema}.stock_group_summary d
      WHERE d.company_id = ${alias}.company_id
        AND ${normName("d.item_name")} = ${normName(`${alias}.item_name`)}
        AND d.deleted_at > COALESCE(${alias}.updated_at, ${alias}.created_at)
    )`;
}
