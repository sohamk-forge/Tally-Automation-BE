exports.up = function(knex) {

  return knex.schema
    .withSchema("app")
    .table(
      "companies",
      (table) => {

        table.dropColumn(
          "under_group"
        );

        table.dropColumn(
          "address"
        );

        table.dropColumn(
          "state"
        );

        table.dropColumn(
          "gst_number"
        );

        table.dropColumn(
          "tally_company_name"
        );

      }
    );

};

exports.down = function(knex) {

  return Promise.resolve();

};