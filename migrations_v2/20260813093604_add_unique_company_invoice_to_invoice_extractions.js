export async function up(knex) {

  // 1. Dedupe: keep one row per (company_id, invoice_no) — most
  //    recently updated, ties broken by highest id.
  await knex.raw(
    `
    DELETE FROM app_test.invoice_extractions as t
    USING (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY company_id, invoice_no
               ORDER BY updated_at DESC, id DESC
             ) AS rn
      FROM app_test.invoice_extractions
    ) ranked
    WHERE t.id = ranked.id
      AND ranked.rn > 1
  `
  );

  // 2. Add the constraint now that duplicates are gone. This is what
  //    ON CONFLICT (company_id, invoice_no) in both purchase workers
  //    actually needs to exist to work.
  await knex.schema
    .withSchema("app_test")
    .alterTable("invoice_extractions", (table) => {
      table.unique(
        ["company_id", "invoice_no"],
        {
          indexName: "invoice_extractions_company_invoice_unique"
        }
      );
    });

}

export async function down(knex) {

  await knex.schema
    .withSchema("app_test")
    .alterTable("invoice_extractions", (table) => {
      table.dropUnique(
        ["company_id", "invoice_no"],
        "invoice_extractions_company_invoice_unique"
      );
    });

}
