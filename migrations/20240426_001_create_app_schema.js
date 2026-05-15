exports.up = function (knex) {
  await knex.schema.createSchemaIfNotExists('app');
};

exports.down = function (knex) {
  await knex.schema.dropSchemaIfExists('app', true);
};