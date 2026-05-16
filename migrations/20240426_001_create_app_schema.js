export async function up(knex) {
  await knex.schema.createSchemaIfNotExists('app');
};

export async function down(knex) {
  await knex.schema.dropSchemaIfExists('app', true);
};
