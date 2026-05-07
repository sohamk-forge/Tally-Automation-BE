exports.up = function (knex) {
  return knex.schema.createSchemaIfNotExists('app');
};

exports.down = function (knex) {
  return knex.schema.dropSchemaIfExists('app', true);
};