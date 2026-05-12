exports.up = function (knex) {
  await knex.schema.withSchema('app').table('users', (table) => {
    table.string('phone').nullable();
  });
};

exports.down = function (knex) {
  await knex.schema.withSchema('app').table('users', (table) => {
    table.dropColumn('phone');
  });
};