import { DB_SCHEMA } from "../src/config/db.js";
export async function up(knex) {

    await knex.schema
        .withSchema(DB_SCHEMA)
        .createTable("connector_jobs", (table) => {

            table.increments("id").primary();

            table.bigInteger("user_id").notNullable();

            table.integer("connector_machine_id")
                .unsigned()
                .references("id")
                .inTable(`${DB_SCHEMA}.connector_machines`)
                .onDelete("SET NULL");

            table.string("job_type");

            table.string("status")
                .notNullable()
                .defaultTo("pending");

            table.jsonb("payload");

            table.text("request_xml");

            table.text("response_xml");

            table.jsonb("result");

            table.text("error_message");

            table.integer("attempt_count")
                .notNullable()
                .defaultTo(0);

            table.timestamp("claimed_at").nullable();

            table.timestamp("last_attempt_at").nullable();

            table.timestamp("created_at")
                .defaultTo(knex.fn.now());

            table.timestamp("updated_at")
                .defaultTo(knex.fn.now());

            table.timestamp("completed_at").nullable();

            // PENDING JOB LOOKUP (GET /api/connector/jobs)
            table.index(["user_id", "status"]);

            // CONNECTOR MACHINE LOOKUP
            table.index(["connector_machine_id"]);

            // STATUS LOOKUP
            table.index(["status"]);

        });

}

export async function down(knex) {

    await knex.schema
        .withSchema(DB_SCHEMA)
        .dropTableIfExists("connector_jobs");

}
