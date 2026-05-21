export async function up(knex) {
  const hasFirstName = await knex.schema
    .withSchema("app")
    .hasColumn("users", "first_name");

  const hasLastName = await knex.schema
    .withSchema("app")
    .hasColumn("users", "last_name");

  if (!hasFirstName || !hasLastName) {
    await knex.schema
      .withSchema("app")
      .alterTable("users", function (table) {
        if (!hasFirstName) {
          table.string("first_name").nullable();
        }

        if (!hasLastName) {
          table.string("last_name").nullable();
        }
      });
  }
};

export async function down(knex) {
  const hasFirstName = await knex.schema
    .withSchema("app")
    .hasColumn("users", "first_name");

  const hasLastName = await knex.schema
    .withSchema("app")
    .hasColumn("users", "last_name");

  await knex.schema
    .withSchema("app")
    .alterTable("users", function (table) {
      if (hasFirstName) {
        table.dropColumn("first_name");
      }

      if (hasLastName) {
        table.dropColumn("last_name");
      }
    });
};