import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { ciDatabaseUrl, ciEnvironment, DEFAULT_DATABASE_URL } from "../src/stockflow-ci-env.mjs";

test("CI uses only synthetic sessions and strips signing, database and provider settings", () => {
  const env = ciEnvironment({
    PATH: process.env.PATH, HOME: process.env.HOME,
    DATABASE_URL: "postgresql://production.invalid/real",
    SESSION_SECRET: "do-not-inherit", DEPLOYER_PRIVATE_KEY: "do-not-inherit",
    RELAYER_PRIVATE_KEY: "do-not-inherit", ADMIN_PRIVATE_KEY: "do-not-inherit",
    CDP_API_KEY_PRIVATE_KEY: "do-not-inherit", VITE_ONCHAINKIT_API_KEY: "do-not-inherit",
    STOCKFLOW_PILOT_ENABLED: "true", NODE_OPTIONS: "--inspect",
  });
  assert.equal(env.DATABASE_URL, DEFAULT_DATABASE_URL);
  assert.equal(env.STOCKFLOW_PILOT_ENABLED, "false");
  assert(env.SESSION_SECRET.length >= 32);
  assert(!JSON.stringify(env).includes("do-not-inherit"));
  assert(!env.NODE_OPTIONS.includes("--inspect"));
});

test("CI rejects non-disposable database targets and URL overrides", () => {
  assert.equal(ciDatabaseUrl(DEFAULT_DATABASE_URL.replace(":5432", ":55432")),
    DEFAULT_DATABASE_URL.replace(":5432", ":55432"));
  for (const value of [
    "postgresql://stockflow_ci:stockflow_ci@production.invalid/stockflow_ci",
    DEFAULT_DATABASE_URL.replace("/stockflow_ci", "/basepay"),
    DEFAULT_DATABASE_URL.replace("stockflow_ci:", "operator:"),
    `${DEFAULT_DATABASE_URL}?host=production.invalid`, `${DEFAULT_DATABASE_URL}#override`,
  ]) assert.throws(() => ciDatabaseUrl(value), /disposable loopback/);
});

function child(source, args = []) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source, ...args], {
    env: ciEnvironment(process.env), encoding: "utf8", timeout: 10_000,
  });
}

test("unmocked public fetch, HTTP, HTTPS and TCP fail before making a connection", () => {
  for (const source of [
    "await fetch('https://mainnet.base.org')",
    "const {get} = await import('node:http'); get('http://mainnet.base.org')",
    "const {get} = await import('node:https'); get('https://mainnet.base.org')",
    "const {connect} = await import('node:net'); connect(443, 'mainnet.base.org')",
  ]) {
    const result = child(source);
    assert.notEqual(result.status, 0, source);
    assert.match(result.stderr, /blocked non-loopback network access/, source);
  }
});

test("local HTTP fixtures still work", () => {
  const result = child(`
    const {createServer} = await import('node:http');
    const server = createServer((req, res) => res.end('fixture'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch('http://127.0.0.1:' + server.address().port);
      if (await res.text() !== 'fixture') throw new Error('bad response');
    } finally { server.closeAllConnections(); server.close(); }
  `);
  assert.equal(result.status, 0, result.stderr);
});

test("live and funded test flags fail closed", () => {
  for (const flag of ["--live", "--http", "--funded"]) {
    const result = child("throw new Error('test body must not run')", ["--", flag]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not allow live/);
  }
});
