import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
  const hasDebitCredit      = await knex.schema.withSchema(DB_SCHEMA).hasColumn("contra_vouchers", "debit_credit");
  const hasErrMessage       = await knex.schema.withSchema(DB_SCHEMA).hasColumn("contra_vouchers", "err_message");
  const hasStatementPassword= await knex.schema.withSchema(DB_SCHEMA).hasColumn("contra_vouchers", "statement_password");
  const hasFileName         = await knex.schema.withSchema(DB_SCHEMA).hasColumn("contra_vouchers", "file_name");
  const hasUpdatedAt        = await knex.schema.withSchema(DB_SCHEMA).hasColumn("contra_vouchers", "updated_at");

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("contra_vouchers", (table) => {
      if (!hasDebitCredit)       table.string("debit_credit");
      if (!hasErrMessage)        table.text("err_message");
      if (!hasStatementPassword) table.string("statement_password");
      if (!hasFileName)          table.string("file_name");
      if (!hasUpdatedAt)         table.timestamp("updated_at").defaultTo(knex.fn.now());
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("contra_vouchers", (table) => {
      table.dropColumn("debit_credit");
      table.dropColumn("err_message");
      table.dropColumn("statement_password");
      table.dropColumn("file_name");
      table.dropColumn("updated_at");
    });
}