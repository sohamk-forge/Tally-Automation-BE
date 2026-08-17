export async function up(knex) {
  // Create gst_credentials table
  await knex.schema
    .withSchema("app_test")
    .createTable("gst_credentials", (table) => {
      table.increments("id").primary();

      table
        .integer("company_id")
        .notNullable()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.string("gstin", 15).notNullable();

      table.text("client_id").notNullable();

      // AES-256-GCM encrypted client secret
      table.text("client_secret_enc").notNullable();

      table.text("gst_username");

      // AES-256-GCM encrypted GST password
      table.text("gst_password_enc");

      table
        .timestamp("created_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());

      table
        .timestamp("updated_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());

      table.unique(["company_id", "gstin"]);
    });

  // Create gst_auth_sessions table
  await knex.schema
    .withSchema("app_test")
    .createTable("gst_auth_sessions", (table) => {
      table.increments("id").primary();

      table
        .integer("company_id")
        .notNullable()
        .references("id")
        .inTable("app_test.companies")
        .onDelete("CASCADE");

      table.string("gstin", 15).notNullable();

      // From WhiteBooks otprequest response
      table.text("txn_id");

      // From WhiteBooks authtoken response
      table.text("ref_id");

      // AES-256-GCM encrypted auth token
      table.text("auth_token_enc");

      table.timestamp("expires_at", { useTz: true });

      table
        .string("status", 20)
        .notNullable()
        .defaultTo("PENDING_OTP");

      table
        .integer("created_by")
        .references("id")
        .inTable("app_test.users");

      table
        .timestamp("created_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());

      table
        .timestamp("updated_at", { useTz: true })
        .notNullable()
        .defaultTo(knex.fn.now());

      table.check(
        "status IN ('PENDING_OTP', 'AUTHENTICATED', 'FAILED', 'EXPIRED')"
      );
    });

  // Index for company + GSTIN + latest session
  await knex.schema
    .withSchema("app_test")
    .raw(`
      CREATE INDEX IF NOT EXISTS idx_gst_auth_sessions_company_gstin
      ON app_test.gst_auth_sessions (company_id, gstin, id DESC)
    `);
}

export async function down(knex) {
  // Drop sessions first because it references users/companies
  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("gst_auth_sessions");

  await knex.schema
    .withSchema("app_test")
    .dropTableIfExists("gst_credentials");
}