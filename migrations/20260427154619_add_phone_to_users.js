exports.up = function(knex) {
  return knex.schema.alterTable('users', function(table) {
    table.string('phone').nullable();
  });
};

exports.down = function(knex) {
  return knex.schema.alterTable('users', function(table) {
    table.dropColumn('phone');
  });
};
