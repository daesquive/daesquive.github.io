import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import Trip from "../data.js";
import worker from "./src/worker.js";

const otherWorker = (await import("./src/worker.js?independent-isolate")).default;
const migration = readFileSync(new URL("./migrations/0001_agenda.sql", import.meta.url), "utf8");
const TEST_KEY = "synthetic-test-key-not-a-real-credential";
const MAX_BYTES = 1024 * 1024;
const snapshot = (revision, events) => ({ version: 1, language: "es", revision, events });
const event = (id, changes = {}) => ({
  id,
  title: "Plan de prueba",
  date: "2026-11-01",
  endDate: "2026-11-01",
  time: "10:00",
  endTime: "11:00",
  zone: Trip.ZONES[0],
  type: "activity",
  status: Trip.STATUSES[0],
  stay: "",
  stop: "",
  reminder: Trip.REMINDERS[0],
  location: "",
  notes: "",
  url: "",
  done: false,
  ...changes
});

function sqliteBinding(sqlite, beforeExecute = () => {}) {
  function statement(sql, values = []) {
    return {
      bind(...parameters) {
        return statement(sql, parameters);
      },
      async first() {
        await beforeExecute(sql, "first");
        const row = sqlite.prepare(sql).get(...values);
        return row ? { ...row } : null;
      },
      async run() {
        await beforeExecute(sql, "run");
        const result = sqlite.prepare(sql).run(...values);
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      }
    };
  }
  return { prepare: sql => statement(sql) };
}

function strictVerifier({ status = 200, reply = { ok: true }, throws = false } = {}) {
  return {
    calls: 0,
    async fetch(input, init) {
      this.calls++;
      const request = new Request(input, init);
      assert.equal(request.url, "https://family-auth.internal/api/verify");
      assert.equal(request.method, "POST");
      assert.equal(request.redirect, "manual");
      assert.deepEqual([...request.headers.keys()], ["content-type"]);
      assert.equal(request.headers.get("Content-Type"), "application/json");
      const body = await request.json();
      assert.deepEqual(Object.keys(body), ["passphrase"]);
      assert.equal(typeof body.passphrase, "string");
      if (throws) throw new Error("Private verifier diagnostics");
      if (body.passphrase !== TEST_KEY) return Response.json({ error: "No" }, { status: 401 });
      return new Response(
        [204, 304].includes(status) ? null : typeof reply === "string" ? reply : JSON.stringify(reply),
        { status, headers: { "Content-Type": "application/json" } }
      );
    }
  };
}

function setup(t, { migrated = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  if (migrated) sqlite.exec(migration);
  t.after(() => sqlite.close());
  const env = { DB: sqliteBinding(sqlite), FAMILY_AUTH: strictVerifier() };
  return { sqlite, env };
}

function quietErrors(t) {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  return logs;
}

async function call(env, options = {}) {
  const { method = "GET", path = "/api/agenda", origin, key, handler = worker } = options;
  const headers = new Headers(options.headers);
  if (origin !== undefined) headers.set("Origin", origin);
  if (key !== undefined) headers.set("X-Family-Passphrase", key);
  let body = options.body;
  if (body !== undefined) {
    if (typeof body !== "string" && !(body instanceof Uint8Array) && !(body instanceof ReadableStream)) {
      body = JSON.stringify(body);
    }
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  const response = await handler.fetch(new Request(`https://agenda.test${path}`, {
    method, headers, body, ...(body instanceof ReadableStream ? { duplex: "half" } : {})
  }), env);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Vary"), "Origin");
  if (response.status === 204) {
    assert.equal(await response.text(), "");
    return { response, data: null };
  }
  assert.match(response.headers.get("Content-Type"), /^application\/json/);
  const data = await response.json();
  if (response.status >= 400) assert.equal(typeof data.error, "string");
  return { response, data };
}

function put(env, revision, events, options = {}) {
  return call(env, { method: "PUT", key: TEST_KEY, body: snapshot(revision, events), ...options });
}

function stored(sqlite) {
  const row = sqlite.prepare("SELECT revision, events FROM agenda WHERE id = 1").get();
  return row ? snapshot(row.revision, JSON.parse(row.events)) : null;
}

test("concurrent first reads seed one durable singleton without requiring authentication", async t => {
  const { sqlite, env } = setup(t);
  delete env.FAMILY_AUTH;
  const results = await Promise.all([call(env), call(env, { handler: otherWorker }), call(env)]);
  for (const { response, data } of results) {
    assert.equal(response.status, 200);
    assert.equal(data.version, 1);
    assert.equal(data.language, "es");
    assert.equal(data.revision, 0);
    assert.ok(isDeepStrictEqual(data.events, Trip.SEED), "Initial events must match the validated seed");
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM agenda").get().count, 1);
});

test("independent clients share added, edited, deleted and empty snapshots without reseeding", async t => {
  const { sqlite, env } = setup(t);
  const otherEnv = { DB: sqliteBinding(sqlite), FAMILY_AUTH: strictVerifier() };
  const first = event("first");
  const second = event("second");
  const edits = [
    [first],
    [first, second],
    [{ ...first, title: "Cambio compartido", done: true }, second],
    [second],
    []
  ];
  await call(env);
  for (let revision = 0; revision < edits.length; revision++) {
    const saved = await put(env, revision, edits[revision]);
    assert.equal(saved.response.status, 200);
    assert.deepEqual(saved.data, snapshot(revision + 1, edits[revision]));
    const read = await call(otherEnv, { handler: otherWorker });
    assert.equal(read.response.status, 200);
    assert.deepEqual(read.data, saved.data);
    assert.deepEqual(stored(sqlite), saved.data);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM agenda").get().count, 1);
});

test("an authenticated first write initializes and saves instead of requiring a prior GET", async t => {
  const { sqlite, env } = setup(t);
  const result = await put(env, 0, [event("first-write")]);
  assert.equal(result.response.status, 200);
  assert.deepEqual(stored(sqlite), result.data);
  assert.equal(result.data.revision, 1);
});

test("atomic compare-and-swap permits only one concurrent writer and returns the winner on conflicts", async t => {
  const { sqlite, env } = setup(t);
  const otherEnv = { DB: sqliteBinding(sqlite), FAMILY_AUTH: strictVerifier() };
  const results = await Promise.all([
    put(env, 0, [event("client-a")]),
    put(otherEnv, 0, [event("client-b")], { handler: otherWorker })
  ]);
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
  const winner = results.find(result => result.response.status === 200).data;
  const conflict = results.find(result => result.response.status === 409).data;
  assert.equal(winner.revision, 1);
  assert.deepEqual(conflict.current, winner);
  const stale = await put(env, 0, [event("stale")]);
  assert.equal(stale.response.status, 409);
  assert.deepEqual(stale.data.current, winner);
  assert.deepEqual((await call(otherEnv)).data, winner);
  assert.deepEqual(stored(sqlite), winner);
});

test("invalid envelopes and events never replace or partially edit persisted data", async t => {
  const { sqlite, env } = setup(t);
  const valid = event("valid");
  const baseline = (await put(env, 0, [valid])).data;
  const good = snapshot(1, [valid]);
  const bad = [
    null, [], "not-an-envelope",
    { ...good, version: 2 },
    { ...good, version: "1" },
    { ...good, language: "en" },
    { ...good, revision: -1 },
    { ...good, revision: 1.5 },
    { ...good, revision: "1" },
    { ...good, revision: Number.MAX_SAFE_INTEGER + 1 },
    { version: 1, language: "es", events: [valid] },
    { ...good, extra: true },
    { ...good, events: null },
    { ...good, events: [valid, valid] },
    ...[
      { title: "" }, { date: "2026-11-31" }, { time: "25:00" },
      { endTime: "09:00" }, { done: "true" }, { url: "javascript:alert(1)" },
      { id: "invalid id" }, { zone: "invalid" }, { stay: "hotel", type: "activity" }
    ].map(change => snapshot(1, [event("valid", change)]))
  ];
  for (const body of bad) {
    const result = await call(env, { method: "PUT", key: TEST_KEY, body });
    assert.equal(result.response.status, 400);
    assert.deepEqual(stored(sqlite), baseline);
  }
});

test("invalid requests do not even initialize an absent agenda", async t => {
  const { sqlite, env } = setup(t);
  for (const body of ["{", snapshot(0, [{}]), new Uint8Array([0xff])]) {
    const result = await call(env, { method: "PUT", key: TEST_KEY, body });
    assert.equal(result.response.status, 400);
    assert.equal(stored(sqlite), null);
  }
  const missing = await call(env, { method: "PUT", key: TEST_KEY });
  assert.equal(missing.response.status, 400);
  assert.equal(stored(sqlite), null);
});

test("write keys are forwarded only to the bound verifier and missing or incorrect keys cannot write", async t => {
  const { sqlite, env } = setup(t);
  for (const key of [undefined, "", "   ", "incorrect-test-key", `${TEST_KEY}-extra`]) {
    const result = await put(env, 0, [event("auth")], { key });
    assert.equal(result.response.status, 401);
    assert.equal(stored(sqlite), null);
  }
  assert.equal(env.FAMILY_AUTH.calls, 2);
  const success = await put(env, 0, [event("auth")]);
  assert.equal(success.response.status, 200);
  assert.equal(env.FAMILY_AUTH.calls, 3);
});

test("missing and broken service bindings fail closed without trusting a separate secret", async t => {
  const { sqlite, env } = setup(t);
  const logs = quietErrors(t);
  for (const binding of [undefined, {}, { fetch: "not-a-function" }]) {
    const result = await put({ ...env, FAMILY_AUTH: binding, FAMILY_PASSPHRASE: TEST_KEY }, 0, [event("binding")]);
    assert.equal(result.response.status, 503);
    assert.equal(stored(sqlite), null);
  }
  assert.equal(logs.length, 3);
});

test("verifier denial maps to 401 and every other verification failure is an explicit 503", async t => {
  const { sqlite, env } = setup(t);
  const logs = quietErrors(t);
  const cases = [
    ...[401, 403].map(status => [{ status, reply: { error: "Private upstream detail" } }, 401]),
    ...[201, 204, 302, 400, 429, 500, 503].map(status => [{ status }, 503]),
    ...["not-json", "", { ok: false }, { ok: "true" }, {}, null, [], true].map(reply => [{ reply }, 503]),
    [{ throws: true }, 503]
  ];
  for (const [behavior, expectedStatus] of cases) {
    const auth = strictVerifier(behavior);
    const result = await put({ ...env, FAMILY_AUTH: auth }, 0, [event("verifier")]);
    assert.equal(result.response.status, expectedStatus);
    assert.equal(auth.calls, 1);
    assert.equal(stored(sqlite), null);
    assert.doesNotMatch(result.data.error, /Private|diagnostics/);
  }
  assert.ok(logs.length > 0);
  assert.ok(logs.every(args => isDeepStrictEqual(args, ["[iberia-trip-agenda] Servicio de agenda no disponible."])));
});

test("allowed origins receive exact CORS headers and GET needs neither a key nor verifier", async t => {
  const { env } = setup(t);
  delete env.FAMILY_AUTH;
  for (const origin of ["https://daesquive.github.io", "http://127.0.0.1:8788", "http://localhost:8788"]) {
    const result = await call(env, { origin });
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get("Access-Control-Allow-Origin"), origin);
  }
  const noOrigin = await call(env);
  assert.equal(noOrigin.response.status, 200);
  assert.equal(noOrigin.response.headers.get("Access-Control-Allow-Origin"), null);
});

test("unexpected and opaque origins are rejected before any read, initialization or verifier call", async t => {
  const { sqlite, env } = setup(t);
  for (const origin of [
    "https://example.com", "null", "https://daesquive.github.io.attacker.test",
    "http://daesquive.github.io", "http://localhost:8790", "https://daesquive.github.io/"
  ]) {
    for (const method of ["GET", "PUT", "OPTIONS"]) {
      const result = await call(env, {
        origin, method, key: TEST_KEY, ...(method === "PUT" ? { body: snapshot(0, [event("origin")]) } : {})
      });
      assert.equal(result.response.status, 403);
      assert.equal(result.response.headers.get("Access-Control-Allow-Origin"), null);
    }
  }
  assert.equal(stored(sqlite), null);
  assert.equal(env.FAMILY_AUTH.calls, 0);
});

test("preflight permits only agreed methods and headers, without requiring storage or auth", async () => {
  const origin = "https://daesquive.github.io";
  const result = await call({}, {
    method: "OPTIONS", origin,
    headers: {
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type, X-FAMILY-PASSPHRASE"
    }
  });
  assert.equal(result.response.status, 204);
  assert.equal(result.response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(result.response.headers.get("Access-Control-Allow-Methods"), "GET, PUT, OPTIONS");
  assert.equal(result.response.headers.get("Access-Control-Allow-Headers"), "Content-Type, X-Family-Passphrase");
  const badMethod = await call({}, {
    method: "OPTIONS", origin, headers: { "Access-Control-Request-Method": "DELETE" }
  });
  assert.equal(badMethod.response.status, 405);
  assert.equal(badMethod.response.headers.get("Allow"), "GET, PUT, OPTIONS");
  const badHeader = await call({}, {
    method: "OPTIONS", origin, headers: { "Access-Control-Request-Headers": "Authorization" }
  });
  assert.equal(badHeader.response.status, 403);
});

test("server-side no-Origin writes still authenticate, and unsupported routes and methods are explicit", async t => {
  const { env } = setup(t);
  const written = await put(env, 0, [event("server-side")]);
  assert.equal(written.response.status, 200);
  assert.equal(written.response.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal((await put(env, 1, [], { key: undefined })).response.status, 401);
  assert.equal((await call(env, { path: "/missing" })).response.status, 404);
  for (const method of ["POST", "DELETE", "PATCH"]) {
    const result = await call(env, { method });
    assert.equal(result.response.status, 405);
    assert.equal(result.response.headers.get("Allow"), "GET, PUT, OPTIONS");
  }
});

test("oversized streamed and declared bodies are cancelled before any agenda mutation", async t => {
  const { sqlite, env } = setup(t);
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(512 * 1024).fill(32));
    },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 });
  const result = await call(env, { method: "PUT", key: TEST_KEY, body, headers: { "Content-Length": "1" } });
  assert.equal(result.response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(pulled, 3);
  assert.equal(stored(sqlite), null);

  pulled = 0;
  cancelled = false;
  const declared = new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array([32])); },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 });
  const rejected = await call(env, {
    method: "PUT", key: TEST_KEY, body: declared, headers: { "Content-Length": String(MAX_BYTES + 1) }
  });
  assert.equal(rejected.response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(pulled, 0);
  assert.equal(stored(sqlite), null);
});

test("the byte limit accepts exactly 1 MiB, preserves split UTF-8, and rejects oversized encoded events", async t => {
  const { sqlite, env } = setup(t);
  const events = [event("unicode", { title: "Prueba á" })];
  const encoded = Buffer.from(JSON.stringify(snapshot(0, events)));
  const exact = Buffer.concat([encoded, Buffer.alloc(MAX_BYTES - encoded.length, 32)]);
  const split = encoded.indexOf(Buffer.from("á")) + 1;
  const chunks = [exact.subarray(0, split), exact.subarray(split)];
  const body = new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(chunks.shift());
      else controller.close();
    }
  });
  const accepted = await call(env, { method: "PUT", key: TEST_KEY, body });
  assert.equal(accepted.response.status, 200);
  assert.deepEqual(accepted.data, snapshot(1, events));
  const baseline = stored(sqlite);

  const oversized = await call(env, { method: "PUT", key: TEST_KEY, body: "á".repeat(MAX_BYTES / 2 + 1) });
  assert.equal(oversized.response.status, 413);
  assert.deepEqual(stored(sqlite), baseline);

  const expandedEvent = JSON.stringify(event("expanded")).replace(
    /}$/, `,"extra":[${"1e20,".repeat(50000)}1e20]}`
  );
  const compact = `{"version":1,"language":"es","revision":1,"events":[${expandedEvent}]}`;
  assert.ok(Buffer.byteLength(compact) < MAX_BYTES);
  const expanded = await call(env, { method: "PUT", key: TEST_KEY, body: compact });
  assert.equal(expanded.response.status, 413);
  assert.deepEqual(stored(sqlite), baseline);
});

test("a failed request stream returns 400 and never initializes or partially writes data", async t => {
  const { sqlite, env } = setup(t);
  const body = new ReadableStream({
    pull(controller) { controller.error(new Error("Private stream detail")); }
  });
  const result = await call(env, { method: "PUT", key: TEST_KEY, body });
  assert.equal(result.response.status, 400);
  assert.doesNotMatch(result.data.error, /Private/);
  assert.equal(stored(sqlite), null);
});

test("missing, unmigrated and failing databases return 503 rather than a seed fallback", async t => {
  const { sqlite, env } = setup(t, { migrated: false });
  const logs = quietErrors(t);
  const broken = sqliteBinding(sqlite, () => { throw new Error("Private database diagnostics"); });
  for (const db of [undefined, {}, env.DB, broken]) {
    const result = await call({ ...env, DB: db });
    assert.equal(result.response.status, 503);
    assert.equal(Object.hasOwn(result.data, "events"), false);
    assert.doesNotMatch(result.data.error, /Private|SELECT|table/);
  }
  sqlite.exec(migration);
  const failedInitialization = sqliteBinding(sqlite, sql => {
    if (sql.startsWith("INSERT")) throw new Error("Private initialization detail");
  });
  assert.equal((await call({ ...env, DB: failedInitialization })).response.status, 503);
  assert.equal(stored(sqlite), null);
  assert.equal(logs.length, 5);
  assert.ok(logs.every(args => isDeepStrictEqual(args, ["[iberia-trip-agenda] Servicio de agenda no disponible."])));
});

test("write and conflict-read failures are explicit 503s and cannot replace the persisted snapshot", async t => {
  const { sqlite, env } = setup(t);
  quietErrors(t);
  const baseline = (await put(env, 0, [event("persisted")])).data;
  const failedWrite = sqliteBinding(sqlite, sql => {
    if (sql.startsWith("UPDATE")) throw new Error("Private write detail");
  });
  assert.equal((await put({ ...env, DB: failedWrite }, 1, [])).response.status, 503);
  assert.deepEqual(stored(sqlite), baseline);
  let reads = 0;
  const failedConflictRead = sqliteBinding(sqlite, sql => {
    if (sql.startsWith("SELECT") && ++reads === 2) throw new Error("Private conflict detail");
  });
  assert.equal((await put({ ...env, DB: failedConflictRead }, 0, [])).response.status, 503);
  assert.deepEqual(stored(sqlite), baseline);
});

test("corrupt existing data is surfaced, not silently replaced or reset to the seed", async t => {
  const { sqlite, env } = setup(t);
  quietErrors(t);
  await put(env, 0, [event("original")]);
  sqlite.prepare("UPDATE agenda SET events = ? WHERE id = 1").run("[{}]");
  assert.equal((await call(env)).response.status, 503);
  assert.equal((await put(env, 1, [event("replacement")])).response.status, 503);
  assert.equal(sqlite.prepare("SELECT events FROM agenda WHERE id = 1").get().events, "[{}]");
});

test("maximum safe revisions remain readable but cannot overflow or bypass stale-write protection", async t => {
  const { sqlite, env } = setup(t);
  quietErrors(t);
  await put(env, 0, [event("revision-limit")]);
  sqlite.prepare("UPDATE agenda SET revision = ? WHERE id = 1").run(Number.MAX_SAFE_INTEGER);
  const baseline = stored(sqlite);
  assert.deepEqual((await call(env)).data, baseline);
  assert.equal((await put(env, Number.MAX_SAFE_INTEGER, [])).response.status, 503);
  const stale = await put(env, 0, []);
  assert.equal(stale.response.status, 409);
  assert.deepEqual(stale.data.current, baseline);
  assert.deepEqual(stored(sqlite), baseline);
});
