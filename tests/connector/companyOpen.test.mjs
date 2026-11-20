// node --test --test-force-exit tests/connector/companyOpen.test.mjs
// LOCAL database only (refuses otherwise). Borrows one existing company + member, inserts one temporary
// connector key row, drives the real heartbeat middleware over HTTP, and deletes the row afterwards.
import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST || "")) {
  throw new Error(`Refusing to run: DB_HOST is "${process.env.DB_HOST}", not local`);
}

const { default: pool } = await import("../../src/db/index.js");
const { DB_SCHEMA } = await import("../../src/config/db.js");
const { verifyConnectorApiKey, hashApiKey } = await import("../../src/middleware/apiKey.middleware.js");
const svc = await import("../../src/services/connectorOwner.service.js");

let server, base, keyId, company;
const rawKey = "qa-" + crypto.randomBytes(12).toString("hex");

const heartbeat = (headers = {}) =>
  fetch(`${base}/hb`, { headers: { "x-connector-api-key": rawKey, "x-tally-connected": "true", "x-tally-checked-ago-ms": "0", ...headers } });
const status = () => svc.getTallyStatusForKey(keyId);
const columnExists = async () =>
  (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='connector_api_keys' AND column_name='tally_company'`, [DB_SCHEMA])).rowCount > 0;

before(async () => {
  const r = await pool.query(
    `SELECT c.id, c.name, cm.user_id FROM ${DB_SCHEMA}.companies c JOIN ${DB_SCHEMA}.company_members cm ON cm.company_id = c.id WHERE c.name IS NOT NULL LIMIT 1`
  );
  assert.ok(r.rows[0], "need one company with a member in the local DB");
  company = r.rows[0];
  const k = await pool.query(
    `INSERT INTO ${DB_SCHEMA}.connector_api_keys (user_id, machine_id, key_hash, company_id) VALUES ($1, 'qa-company-open-test', $2, $3) RETURNING id`,
    [company.user_id, hashApiKey(rawKey), company.id]
  );
  keyId = k.rows[0].id;
  const app = express();
  app.get("/hb", verifyConnectorApiKey, (req, res) => res.json({ ok: true }));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (keyId) await pool.query(`DELETE FROM ${DB_SCHEMA}.connector_api_keys WHERE id = $1`, [keyId]);
  await new Promise((resolve) => server?.close(resolve));
  await pool.end();
});

test("name matching ignores case, spacing and & / and", () => {
  assert.equal(svc.isCompanyOpenInTally("Beta & Sons Pvt Ltd", "BETA  and sons pvt ltd "), true);
  assert.equal(svc.isCompanyOpenInTally("Alpha Traders", "Beta Traders"), false);
  assert.equal(svc.isCompanyOpenInTally("Alpha Traders", null), null);
  assert.equal(svc.isCompanyOpenInTally(null, "Alpha"), null);
});

test("heartbeat still records Tally up/down whether or not the tally_company column exists", async () => {
  const res = await heartbeat({ "x-tally-company": encodeURIComponent(company.name) });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 300)); // the middleware does not wait for the write
  assert.equal((await status()).tally_connected, true);
});

test("selected company open in Tally -> company_open true", async (t) => {
  if (!(await columnExists())) return t.skip("tally_company column not migrated on this DB");
  await heartbeat({ "x-tally-company": encodeURIComponent(company.name.toUpperCase() + "  ") });
  await new Promise((r) => setTimeout(r, 300));
  const st = await status();
  assert.equal(st.tally_company, company.name.toUpperCase());
  assert.equal(await svc.getCompanyOpenState(company.id, st), true);
});

test("a different company open in Tally -> company_open false", async (t) => {
  if (!(await columnExists())) return t.skip("tally_company column not migrated on this DB");
  await heartbeat({ "x-tally-company": encodeURIComponent("Some Other Company Ltd") });
  await new Promise((r) => setTimeout(r, 300));
  const st = await status();
  assert.equal(st.tally_company, "Some Other Company Ltd");
  assert.equal(await svc.getCompanyOpenState(company.id, st), false);
});

test("no company header (older connector) -> unknown, never false", async () => {
  await heartbeat();
  await new Promise((r) => setTimeout(r, 300));
  const st = await status();
  assert.equal(st.tally_company, null);
  assert.equal(await svc.getCompanyOpenState(company.id, st), null);
});

test("malformed header is ignored, heartbeat still works", async () => {
  const res = await heartbeat({ "x-tally-company": "%E0%A4%A" });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await status()).tally_company, null);
});

test("Tally down -> company not reported even if an old value is stored", async (t) => {
  if (!(await columnExists())) return t.skip("tally_company column not migrated on this DB");
  await heartbeat({ "x-tally-company": encodeURIComponent(company.name) });
  await heartbeat({ "x-tally-connected": "false" });
  await new Promise((r) => setTimeout(r, 300));
  const st = await status();
  assert.equal(st.tally_connected, false);
  assert.equal(st.tally_company, null);
});
