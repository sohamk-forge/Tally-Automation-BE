// sales_items and stock_alerts still carry rows from before company_id was
// added, and their readers keep an `OR (company_id IS NULL AND company_name = …)`
// fallback for them. Attribute those rows to a company_id where the name maps
// to exactly one companies row; ambiguous names stay NULL (never guessed).

const BACKFILL_SOURCE = `
  SELECT lower(trim(name)) AS n, min(id) AS id
  FROM app_test.companies
  GROUP BY 1
  HAVING count(*) = 1
`;

export async function up(knex) {
  for (const table of ["sales_items", "stock_alerts"]) {
    await knex.raw(`
      UPDATE app_test.${table} t
      SET company_id = u.id
      FROM (${BACKFILL_SOURCE}) u
      WHERE t.company_id IS NULL
        AND lower(trim(t.company_name)) = u.n
    `);
  }
}

// Data backfill only; there is nothing safe to undo.
export async function down() {}
