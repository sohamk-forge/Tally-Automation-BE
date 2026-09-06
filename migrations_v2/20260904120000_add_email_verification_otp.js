export async function up(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema
    .withSchema(schema)
    .alterTable("users", (table) => {
      table.boolean("email_verified").notNullable().defaultTo(false);
    });

  // Existing accounts already have working access — don't force them
  // through a retroactive OTP check on the next deploy.
  await knex(`${schema}.users`).update({ email_verified: true });

  await knex.schema
    .withSchema(schema)
    .createTable("email_otps", (table) => {
      table.increments("id").primary();

      table.string("email").notNullable();

      table.string("otp_hash").notNullable();

      table.timestamp("expires_at").notNullable();

      table.integer("attempts").notNullable().defaultTo(0);

      table.timestamps(true, true);

      table.index("email");
    });
}

export async function down(knex) {
  const schema = process.env.DB_SCHEMA || "app_test";

  await knex.schema
    .withSchema(schema)
    .dropTableIfExists("email_otps");

  await knex.schema
    .withSchema(schema)
    .alterTable("users", (table) => {
      table.dropColumn("email_verified");
    });
}
