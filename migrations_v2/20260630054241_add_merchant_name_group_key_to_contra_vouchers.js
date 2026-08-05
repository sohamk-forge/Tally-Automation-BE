import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {
  const hasMerchantName = await knex.schema.withSchema(DB_SCHEMA).hasColumn("contra_vouchers", "merchant_name");
  const hasGroupKey     = await knex.schema.withSchema(DB_SCHEMA).hasColumn("contra_vouchers", "group_key");

  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("contra_vouchers", (table) => {
      if (!hasMerchantName) table.text("merchant_name");
      if (!hasGroupKey)     table.text("group_key");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("contra_vouchers", (table) => {
      table.dropColumn("merchant_name");
      table.dropColumn("group_key");
    });
}