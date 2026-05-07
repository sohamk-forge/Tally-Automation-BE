exports.up = function (knex) {
  return knex.schema.withSchema('app').table('users', (table) => {
    table.string('phone').nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.withSchema('app').table('users', (table) => {
    table.dropColumn('phone');
  });
};