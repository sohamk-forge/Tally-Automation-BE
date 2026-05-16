export async function up(knex) {
  await knex.schema.withSchema('app').table('users', (table) => {
    table.string('phone').nullable();
  });
};

export async function down(knex) {
  await knex.schema.withSchema('app').table('users', (table) => {
    table.dropColumn('phone');
  });
};
