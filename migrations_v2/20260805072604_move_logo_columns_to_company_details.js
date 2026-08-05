import { DB_SCHEMA } from "../src/config/db.js";
// migrations/xxxxxxxxxxxxxx_move_logo_columns_to_company_details.js

export async function up(knex) {
  // 1. Add logo columns to company_details
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("company_details", (table) => {
      table.binary("logo_data");
      table.string("logo_mime_type");
      table.string("logo_original_filename");
      table.timestamp("logo_uploaded_at");
    });

  // 2. Remove wrongly added columns from companies
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("companies", (table) => {
      table.dropColumn("logo_data");
      table.dropColumn("logo_mime_type");
      table.dropColumn("logo_original_filename");
      table.dropColumn("logo_uploaded_at");
    });
}


export async function down(knex) {
  // Restore columns back to companies
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("companies", (table) => {
      table.binary("logo_data");
      table.string("logo_mime_type");
      table.string("logo_original_filename");
      table.timestamp("logo_uploaded_at");
    });

  // Remove from company_details
  await knex.schema
    .withSchema(DB_SCHEMA)
    .alterTable("company_details", (table) => {
      table.dropColumn("logo_data");
      table.dropColumn("logo_mime_type");
      table.dropColumn("logo_original_filename");
      table.dropColumn("logo_uploaded_at");
    });
}