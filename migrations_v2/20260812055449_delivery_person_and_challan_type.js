export async function up(knex) {
  const schema = "app_test";

  // 1. Create delivery_persons table
  const hasDeliveryPersons = await knex.schema
    .withSchema(schema)
    .hasTable("delivery_persons");

  if (!hasDeliveryPersons) {
    await knex.schema
      .withSchema(schema)
      .createTable("delivery_persons", (table) => {
        table.increments("id").primary();

        table
          .integer("company_id")
          .notNullable()
          .references("id")
          .inTable(`${schema}.companies`);

        table.string("name", 150).notNullable();
        table.string("phone_number", 20);

        table
          .timestamp("created_at")
          .notNullable()
          .defaultTo(knex.fn.now());
      });
  }

  // 2. Create index
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS "idx_delivery_persons_company"
    ON "${schema}"."delivery_persons" ("company_id")
  `);

  // 3. Add challan_type if it doesn't exist
  const hasChallanType = await knex.schema
    .withSchema(schema)
    .hasColumn("challans", "challan_type");

  if (!hasChallanType) {
    await knex.schema
      .withSchema(schema)
      .alterTable("challans", (table) => {
        table
          .string("challan_type", 50)
          .notNullable()
          .defaultTo("Delivery Challan");
      });
  }

  // 4. Add movement_type if it doesn't exist
  const hasMovementType = await knex.schema
    .withSchema(schema)
    .hasColumn("challans", "movement_type");

  if (!hasMovementType) {
    await knex.schema
      .withSchema(schema)
      .alterTable("challans", (table) => {
        table.string("movement_type", 10);
      });

    await knex.raw(`
      ALTER TABLE "${schema}"."challans"
      ADD CONSTRAINT "challans_movement_type_check"
      CHECK ("movement_type" IN ('inward', 'outward'))
    `);
  }

  // 5. Add delivery_person_id if it doesn't exist
  const hasDeliveryPersonId = await knex.schema
    .withSchema(schema)
    .hasColumn("challans", "delivery_person_id");

  if (!hasDeliveryPersonId) {
    await knex.schema
      .withSchema(schema)
      .alterTable("challans", (table) => {
        table
          .integer("delivery_person_id")
          .references("id")
          .inTable(`${schema}.delivery_persons`);
      });
  }
}

export async function down(knex) {
  const schema = "app_test";

  const hasDeliveryPersonId = await knex.schema
    .withSchema(schema)
    .hasColumn("challans", "delivery_person_id");

  const hasMovementType = await knex.schema
    .withSchema(schema)
    .hasColumn("challans", "movement_type");

  const hasChallanType = await knex.schema
    .withSchema(schema)
    .hasColumn("challans", "challan_type");

  if (hasDeliveryPersonId || movementType || hasChallanType) {
    await knex.schema
      .withSchema(schema)
      .alterTable("challans", (table) => {
        if (hasDeliveryPersonId) {
          table.dropColumn("delivery_person_id");
        }

        if (hasMovementType) {
          table.dropColumn("movement_type");
        }

        if (hasChallanType) {
          table.dropColumn("challan_type");
        }
      });
  }

  await knex.schema
    .withSchema(schema)
    .dropTableIfExists("delivery_persons");
}