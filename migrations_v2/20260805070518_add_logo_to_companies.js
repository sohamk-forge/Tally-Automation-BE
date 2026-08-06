// migrations/xxxxxxxxxxxxxx_add_logo_to_companies.js

export async function up(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("companies", (table) => {
      // Raw bytes of the logo image (already converted from PDF -> PNG
      // before it reaches this column). Stored once at upload time and
      // reused for every voucher render until the user re-uploads it.
      table.binary("logo_data");

      // e.g. "image/png" — needed to build the data URI at render time
      table.string("logo_mime_type");

      // Original uploaded filename, for display in a settings/admin UI
      table.string("logo_original_filename");

      table.timestamp("logo_uploaded_at");
    });
}

export async function down(knex) {
  await knex.schema
    .withSchema("app_test")
    .alterTable("companies", (table) => {
      table.dropColumn("logo_data");
      table.dropColumn("logo_mime_type");
      table.dropColumn("logo_original_filename");
      table.dropColumn("logo_uploaded_at");
    });
}