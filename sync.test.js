"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Trip = require("./data.js");
const { createClient, LEGACY_KEY, CACHE_KEY, MIGRATION_KEY } = require("./sync.js");
const clone = value => JSON.parse(JSON.stringify(value));
const endpoint = "https://calendar.example.test/api/agenda";
const snapshot = (events, revision = 0) => ({ version: 1, language: "es", revision, events: clone(events) });
const sample = () => clone(Trip.SEED.slice(0, 3));
const plan = (id, title = id) => ({ ...clone(Trip.SEED[0]), id, title });
const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(data) });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function memory(entries = [], failWrite = () => false) {
  const values = new Map(entries);
  return {
    values, getItem: key => values.get(key) ?? null,
    setItem(key, value) { if (failWrite(key)) throw new Error("storage unavailable"); values.set(key, value); }
  };
}
function server(events = sample()) {
  let current = snapshot(events);
  const requests = [];
  return {
    requests,
    get current() { return clone(current); },
    update(change) { current = snapshot(change(clone(current.events)), current.revision + 1); },
    async fetch(url, options) {
      assert.equal(url, endpoint);
      assert.equal(options.cache, "no-store");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      requests.push({ method: options.method, body: options.body });
      if (options.method === "GET") {
        assert.equal(options.headers["X-Family-Passphrase"], undefined);
        return reply(200, current);
      }
      assert.equal(options.headers["X-Family-Passphrase"], "unit-test-credential");
      const body = JSON.parse(options.body);
      Trip.validateEvents(body.events);
      if (body.revision !== current.revision) return reply(409, { error: "El calendario cambió.", current });
      current = snapshot(body.events, current.revision + 1);
      return reply(200, current);
    }
  };
}
function client(api, storage = memory(), options = {}) {
  return createClient({
    url: endpoint, storage, fetch: api.fetch.bind(api),
    getPassphrase: async () => "unit-test-credential", refreshFloorMs: 0, ...options
  });
}

test("separate browser stores see canonical additions, edits, completion and deletion without imports", async () => {
  const api = server(), desktopStorage = memory(), mobileStorage = memory();
  const desktop = client(api, desktopStorage), mobile = client(api, mobileStorage);
  await Promise.all([desktop.refresh(), mobile.refresh()]);
  let base = desktop.getSnapshot();
  const added = plan("family-lunch", "Almuerzo familiar");
  await desktop.save(base, [...base.events, added]);
  assert.equal(mobile.getSnapshot().events.length, 3);
  await mobile.refresh();
  assert.deepEqual(mobile.getSnapshot(), desktop.getSnapshot());
  base = mobile.getSnapshot();
  await mobile.save(base, base.events.map(event => event.id === added.id ? { ...event, notes: "A las dos", done: true } : event));
  await desktop.refresh();
  assert.equal(desktop.getSnapshot().events.find(event => event.id === added.id).done, true);
  assert.equal(desktop.getSnapshot().events.find(event => event.id === added.id).notes, "A las dos");
  base = desktop.getSnapshot();
  await desktop.save(base, base.events.filter(event => event.id !== added.id));
  const freshBrowser = client(api);
  await freshBrowser.refresh();
  assert.equal(freshBrowser.getSnapshot().events.length, 3);
  assert.equal(freshBrowser.getSnapshot().events.some(event => event.id === added.id), false);
  assert.equal(desktopStorage.getItem(LEGACY_KEY), null);
  assert.equal(mobileStorage.getItem(LEGACY_KEY), null);
});

test("nonoverlapping concurrent edits survive a revision race and retain the editor's opening base", async () => {
  const api = server(), left = client(api), right = client(api);
  await Promise.all([left.refresh(), right.refresh()]);
  const leftBase = left.getSnapshot(), rightBase = right.getSnapshot();
  const leftDraft = leftBase.events.map((event, index) => index === 0 ? { ...event, title: "Taxi actualizado" } : event);
  const rightDraft = rightBase.events.map((event, index) => index === 1 ? { ...event, notes: "Nota del teléfono" } : event);
  await Promise.all([left.save(leftBase, leftDraft), right.save(rightBase, rightDraft)]);
  assert.equal(api.current.events[0].title, "Taxi actualizado");
  assert.equal(api.current.events[1].notes, "Nota del teléfono");
  assert.equal(api.requests.filter(request => request.method === "PUT").length, 3);
  assert.deepEqual(rightBase.events, sample());

  const openBase = right.getSnapshot();
  api.update(events => events.map((event, index) => index === 2 ? { ...event, title: "Cambio posterior" } : event));
  await right.refresh();
  await assert.rejects(right.save(openBase, openBase.events.map((event, index) => index === 2 ? { ...event, notes: "Texto abierto antes" } : event)), { code: "conflict" });
  assert.equal(right.getSnapshot().events[2].title, "Cambio posterior");
});

test("same-event edits and edit/delete races conflict without overwriting either editor draft", async t => {
  for (const [firstDeletes, secondDeletes] of [[false, false], [false, true], [true, false]]) {
    await t.test(`remote deletion=${firstDeletes}, local deletion=${secondDeletes}`, async () => {
      const api = server(), first = client(api), second = client(api);
      await Promise.all([first.refresh(), second.refresh()]);
      const a = first.getSnapshot(), b = second.getSnapshot(), id = a.events[0].id;
      const firstDraft = firstDeletes ? a.events.filter(event => event.id !== id) : a.events.map(event => event.id === id ? { ...event, title: "Cambio del otro dispositivo" } : event);
      const secondDraft = secondDeletes ? b.events.filter(event => event.id !== id) : b.events.map(event => event.id === id ? { ...event, notes: "Mi texto pendiente" } : event);
      const savedDraft = clone(secondDraft);
      await first.save(a, firstDraft);
      await assert.rejects(second.save(b, secondDraft), error => error.code === "conflict" && error.conflicts[0].id === id && /reabrí/.test(error.message));
      assert.deepEqual(secondDraft, savedDraft);
      assert.deepEqual(second.getSnapshot(), api.current);
      assert.equal(api.requests.filter(request => request.method === "PUT").length, 1);
    });
  }
});

test("an import applies only differences against its opening base and keeps remote additions and unrelated edits", async () => {
  const api = server(), page = client(api);
  await page.refresh();
  const base = page.getSnapshot();
  const imported = [...base.events.slice(1), plan("imported-plan")];
  api.update(events => [...events.map((event, index) => index === 1 ? { ...event, notes: "Cambio remoto independiente" } : event), plan("remote-plan")]);
  await page.save(base, imported);
  assert.equal(api.current.events.some(event => event.id === base.events[0].id), false);
  assert.equal(api.current.events.find(event => event.id === base.events[1].id).notes, "Cambio remoto independiente");
  assert.ok(api.current.events.some(event => event.id === "remote-plan"));
  assert.ok(api.current.events.some(event => event.id === "imported-plan"));
});

test("a stale refresh response cannot roll back a newer confirmed save or its status", async () => {
  const api = server(), delayed = deferred();
  let delayNext = false;
  const page = client(api, memory(), {
    fetch: async (url, options) => {
      const response = await api.fetch(url, options);
      if (options.method === "GET" && delayNext) { delayNext = false; return delayed.promise; }
      return response;
    }
  });
  await page.refresh();
  const base = page.getSnapshot(), oldResponse = reply(200, base);
  delayNext = true;
  const refresh = page.refresh();
  await Promise.resolve();
  await page.save(base, [...base.events, plan("new-confirmed-plan")]);
  delayed.resolve(oldResponse);
  await refresh;
  assert.equal(page.getSnapshot().revision, 1);
  assert.equal(page.getSnapshot().events.at(-1).id, "new-confirmed-plan");
  assert.equal(page.getState().status, "shared");
});

test("polling is coalesced and throttled, and saves block duplicate writes and new background refreshes", async () => {
  const api = server(), delayed = deferred(), authStarted = deferred(), auth = deferred();
  let reads = 0;
  const page = client(api, memory(), {
    refreshFloorMs: 60000,
    fetch: async (url, options) => {
      if (options.method === "GET" && ++reads === 1) return delayed.promise;
      return api.fetch(url, options);
    },
    getPassphrase: () => { authStarted.resolve(); return auth.promise; }
  });
  const one = page.refresh(), two = page.refresh(), three = page.refresh();
  assert.equal(one, two);
  assert.equal(two, three);
  assert.equal(reads, 1);
  delayed.resolve(reply(200, api.current));
  await one;
  await page.refresh();
  assert.equal(reads, 1);
  const base = page.getSnapshot(), draft = [...base.events, plan("one-submit")];
  const saving = page.save(base, draft);
  await authStarted.promise;
  assert.equal(page.getState().saving, true);
  await page.refresh({ force: true });
  assert.equal(reads, 2);
  await assert.rejects(page.save(base, draft), { code: "busy" });
  auth.resolve("unit-test-credential");
  await saving;
  assert.equal(api.current.events.filter(event => event.id === "one-submit").length, 1);
});

test("retrying a save after a lost response confirms the same stable event instead of adding a duplicate", async () => {
  const api = server();
  let loseResponse = true;
  const page = client(api, memory(), {
    fetch: async (url, options) => {
      const response = await api.fetch(url, options);
      if (options.method === "PUT" && loseResponse) { loseResponse = false; throw new TypeError("disconnected"); }
      return response;
    }
  });
  await page.refresh();
  const base = page.getSnapshot(), draft = [...base.events, plan("stable-on-retry")];
  await assert.rejects(page.save(base, draft), { code: "network" });
  assert.equal(page.getSnapshot().revision, 0);
  assert.equal(page.getState().saving, false);
  const confirmed = await page.save(base, draft);
  assert.equal(confirmed.written, false);
  assert.equal(api.current.events.filter(event => event.id === "stable-on-retry").length, 1);
  assert.equal(api.requests.filter(request => request.method === "PUT").length, 1);
});

test("independent revision races have a bounded retry count and preserve the latest server state", async () => {
  const api = server();
  let writes = 0, prompts = 0;
  const page = client(api, memory(), {
    getPassphrase: async () => { prompts++; return "unit-test-credential"; },
    fetch: async (url, options) => {
      if (options.method === "PUT") api.update(events => [...events, plan(`racing-${++writes}`)]);
      return api.fetch(url, options);
    }
  });
  await page.refresh();
  const base = page.getSnapshot();
  await assert.rejects(page.save(base, [...base.events, plan("not-yet-saved")]), { code: "busy" });
  assert.equal(writes, 3);
  assert.equal(prompts, 1);
  assert.deepEqual(page.getSnapshot(), api.current);
  assert.equal(api.current.events.some(event => event.id === "not-yet-saved"), false);
});

test("a same-event conflict on the last allowed revision race is still reported as a conflict", async () => {
  const api = server();
  let writes = 0;
  const page = client(api, memory(), {
    fetch: async (url, options) => {
      if (options.method === "PUT") {
        writes++;
        api.update(events => writes === 3
          ? events.map((event, index) => index === 0 ? { ...event, title: "Último cambio remoto" } : event)
          : [...events, plan(`independent-${writes}`)]);
      }
      return api.fetch(url, options);
    }
  });
  await page.refresh();
  const base = page.getSnapshot();
  await assert.rejects(page.save(base, base.events.map((event, index) => index === 0 ? { ...event, notes: "Mi cambio" } : event)), { code: "conflict" });
  assert.equal(writes, 3);
  assert.equal(page.getSnapshot().events[0].title, "Último cambio remoto");
});

test("HTTP errors never claim a shared save and authentication failure clears the remembered credential", async t => {
  for (const status of [400, 401, 413, 503, 500]) {
    await t.test(`HTTP ${status}`, async () => {
      const api = server();
      let unauthorized = 0;
      const page = client(api, memory(), {
        onUnauthorized: () => { unauthorized++; },
        fetch: (url, options) => options.method === "PUT" ? reply(status, { error: "No disponible" }) : api.fetch(url, options)
      });
      await page.refresh();
      const base = page.getSnapshot(), draft = [...base.events, plan("rejected")];
      await assert.rejects(page.save(base, draft), { status });
      assert.deepEqual(page.getSnapshot(), base);
      assert.deepEqual(api.current, base);
      assert.equal(page.getState().saving, false);
      assert.equal(page.getState().status, "error");
      assert.equal(unauthorized, status === 401 ? 1 : 0);
      assert.equal(draft.at(-1).id, "rejected");
    });
  }
});

test("cancelling password entry leaves the draft available for a later successful save", async () => {
  const api = server();
  let cancel = true;
  const page = client(api, memory(), { getPassphrase: async () => cancel ? null : "unit-test-credential" });
  await page.refresh();
  const base = page.getSnapshot(), draft = [...base.events, plan("cancelled-then-saved")];
  await assert.rejects(page.save(base, draft), { code: "cancelled" });
  assert.equal(api.requests.filter(request => request.method === "PUT").length, 0);
  assert.deepEqual(page.getSnapshot(), base);
  cancel = false;
  await page.save(base, draft);
  assert.equal(api.current.events.at(-1).id, "cancelled-then-saved");
});

test("offline reads retain only a labeled cache and offline edits cannot be accepted as shared saves", async () => {
  const cached = snapshot(sample(), 7), storage = memory([[CACHE_KEY, JSON.stringify(cached)]]);
  const page = createClient({
    url: endpoint, storage, fetch: async () => { throw new TypeError("offline"); },
    getPassphrase: async () => { assert.fail("offline GET must fail before asking for a password"); }
  });
  assert.equal(page.getState().source, "cache");
  await assert.rejects(page.refresh(), { code: "network" });
  await assert.rejects(page.save(cached, [...cached.events, plan("offline-draft")]), { code: "network" });
  assert.deepEqual(page.getSnapshot(), cached);
  assert.equal(page.getState().status, "offline");
  assert.equal(storage.getItem(CACHE_KEY), JSON.stringify(cached));
});

test("the network timeout also covers a stalled response body and releases the refresh lock", async () => {
  const page = createClient({
    url: endpoint, storage: memory(), timeoutMs: 5,
    fetch: async (url, options) => ({
      ok: true, status: 200,
      json: () => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      })
    })
  });
  await assert.rejects(page.refresh(), { code: "network" });
  assert.equal(page.getState().refreshing, false);
  assert.equal(page.getSnapshot(), null);
});

test("missing configuration and unavailable initial service are explicit errors, never a seeded local success", async () => {
  let calls = 0;
  const missing = createClient({ storage: memory(), fetch: () => { calls++; } });
  await assert.rejects(missing.refresh(), { code: "config" });
  assert.equal(calls, 0);
  assert.equal(missing.getSnapshot(), null);
  assert.match(missing.getState().message, /dirección válida/);
  const unavailable = createClient({ url: endpoint, storage: memory(), fetch: async () => reply(503, {}) });
  await assert.rejects(unavailable.refresh(), { status: 503 });
  assert.equal(unavailable.getSnapshot(), null);
});

test("malformed remote envelopes and JSON leave confirmed state and cache untouched", async t => {
  const invalid = [
    null, { ...snapshot(sample()), version: 2 }, { ...snapshot(sample()), language: "en" },
    { ...snapshot(sample()), revision: -1 }, { ...snapshot(sample()), revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot(sample()), revision: "1" }, snapshot([{ ...plan("invalid-date"), date: "2026-11-31" }])
  ];
  for (let index = 0; index <= invalid.length; index++) {
    await t.test(`invalid response ${index}`, async () => {
      const api = server(), storage = memory();
      let broken = false;
      const page = client(api, storage, {
        fetch: (url, options) => broken
          ? index === invalid.length
            ? { ok: true, status: 200, json: async () => { throw new SyntaxError("bad JSON"); } }
            : reply(200, invalid[index])
          : api.fetch(url, options)
      });
      await page.refresh();
      const before = page.getSnapshot(), cached = storage.getItem(CACHE_KEY);
      broken = true;
      await assert.rejects(page.refresh(), { code: "response" });
      assert.deepEqual(page.getSnapshot(), before);
      assert.equal(storage.getItem(CACHE_KEY), cached);
      assert.equal(api.requests.filter(request => request.method === "PUT").length, 0);
    });
  }
});

test("a malformed success or conflict response never confirms an unverified write", async t => {
  for (const [status, response] of [[200, {}], [200, snapshot(sample(), 1)], [409, { current: { revision: 1 } }]]) {
    await t.test(`invalid HTTP ${status}`, async () => {
      const api = server();
      const page = client(api, memory(), {
        fetch: (url, options) => options.method === "PUT" ? reply(status, response) : api.fetch(url, options)
      });
      await page.refresh();
      const base = page.getSnapshot();
      await assert.rejects(page.save(base, [...base.events, plan("not-confirmed")]), { code: "response" });
      assert.deepEqual(page.getSnapshot(), base);
      assert.equal(page.getState().status, "error");
      assert.equal(page.getState().saving, false);
    });
  }
});

test("an invalid cache is reported and preserved, while the actual server calendar still loads", async () => {
  const damaged = '{"version":1,"events":';
  const storage = memory([[CACHE_KEY, damaged]]), api = server([plan("remote-only")]), page = client(api, storage);
  assert.equal(page.getSnapshot(), null);
  assert.match(page.getState().backupWarning, /no es válida/);
  await page.refresh();
  assert.equal(page.getSnapshot().events[0].id, "remote-only");
  assert.equal(storage.getItem(CACHE_KEY), damaged);
});

test("failed local cache writes cannot turn a confirmed shared save into failure", async () => {
  const original = JSON.stringify({ version: 1, language: "es", events: Trip.SEED });
  const storage = memory([[LEGACY_KEY, original]], key => key === CACHE_KEY), api = server(), page = client(api, storage);
  await page.refresh();
  const base = page.getSnapshot();
  const result = await page.save(base, [...base.events, plan("shared-despite-cache-error")]);
  assert.equal(result.written, true);
  assert.equal(page.getState().status, "shared");
  assert.equal(page.getSnapshot().revision, 1);
  assert.equal(api.current.events.at(-1).id, "shared-despite-cache-error");
  assert.match(page.getState().backupWarning, /NO impide/);
  assert.equal(storage.getItem(LEGACY_KEY), original);
});

test("untouched Spanish or migrated English seed backups require no write or password", async t => {
  for (const backup of [{ version: 1, language: "es", events: Trip.SEED }, { version: 1, events: Trip.LEGACY_SEED }]) {
    await t.test(backup.language || "legacy English", async () => {
      const raw = JSON.stringify(backup, null, 2) + "\n", storage = memory([[LEGACY_KEY, raw]]), api = server(Trip.SEED);
      const page = client(api, storage, { getPassphrase: async () => { assert.fail("no edits to share"); } });
      await page.ready();
      assert.equal(page.getState().legacy.hasChanges, false);
      await page.refresh();
      await page.shareLegacy();
      assert.equal(api.requests.filter(request => request.method === "PUT").length, 0);
      assert.equal(storage.getItem(LEGACY_KEY), raw);
      assert.equal(page.getLegacyOriginal(), raw);
    });
  }
});

test("authorized legacy migration merges real additions, edits and deletions without erasing remote changes", async () => {
  const old = clone(Trip.LEGACY_SEED);
  old[0].title = "Mi taxi particular";
  old[0].time = "12:45";
  old.splice(1, 1);
  old.push(plan("old-browser-addition", "Paseo agregado antes"));
  const raw = JSON.stringify({ version: 1, events: old }, null, 2) + "\r\n";
  const storage = memory([[LEGACY_KEY, raw]]);
  const remote = clone(Trip.SEED);
  remote[2].notes = "Nota remota nueva";
  remote.push(plan("other-device-addition"));
  const api = server(remote);
  let prompts = 0;
  const page = client(api, storage, { getPassphrase: async () => { prompts++; return "unit-test-credential"; } });
  await page.ready();
  await page.refresh();
  assert.equal(prompts, 0);
  assert.equal(page.getState().legacy.hasChanges, true);
  assert.equal(api.current.events[0].title, Trip.SEED[0].title);
  await page.shareLegacy();
  assert.equal(prompts, 1);
  assert.equal(api.current.events.find(event => event.id === Trip.SEED[0].id).title, "Mi taxi particular");
  assert.equal(api.current.events.find(event => event.id === Trip.SEED[0].id).notes, Trip.SEED[0].notes);
  assert.equal(api.current.events.some(event => event.id === Trip.SEED[1].id), false);
  assert.equal(api.current.events.find(event => event.id === Trip.SEED[2].id).notes, "Nota remota nueva");
  assert.ok(api.current.events.some(event => event.id === "old-browser-addition"));
  assert.ok(api.current.events.some(event => event.id === "other-device-addition"));
  assert.equal(storage.getItem(LEGACY_KEY), raw);
  assert.equal(page.getLegacyOriginal(), raw);
  assert.equal(page.getState().legacy.migrated, true);

  api.update(events => events.map(event => event.id === Trip.SEED[0].id ? { ...event, title: "Cambio familiar posterior" } : event));
  const reopened = client(api, storage, { getPassphrase: async () => { assert.fail("an exact backup must not be replayed"); } });
  await reopened.ready();
  assert.equal(reopened.getState().legacy.migrated, true);
  const writes = api.requests.filter(request => request.method === "PUT").length;
  await reopened.shareLegacy();
  assert.equal(api.requests.filter(request => request.method === "PUT").length, writes);
  assert.equal(api.current.events.find(event => event.id === Trip.SEED[0].id).title, "Cambio familiar posterior");

  storage.setItem(LEGACY_KEY, raw + " ");
  await reopened.checkLegacy();
  assert.equal(reopened.getState().legacy.migrated, false);
  assert.equal(reopened.getLegacyOriginal(), raw + " ");
});

test("conflicting legacy deletions or edits preserve remote additions and the exact recoverable original", async t => {
  for (const deletes of [true, false]) {
    await t.test(deletes ? "old deletion versus new edit" : "old edit versus new edit", async () => {
      const old = clone(Trip.SEED);
      if (deletes) old.shift();
      else old[0].notes = "Nota antigua local";
      const raw = JSON.stringify({ version: 1, language: "es", events: old });
      const remote = clone(Trip.SEED);
      remote[0].title = "Cambio compartido más reciente";
      remote.push(plan("remote-must-survive"));
      const api = server(remote), storage = memory([[LEGACY_KEY, raw]]), page = client(api, storage);
      await page.ready();
      await assert.rejects(page.shareLegacy(), { code: "conflict" });
      assert.deepEqual(api.current.events, remote);
      assert.deepEqual(page.getSnapshot().events, remote);
      assert.equal(page.getLegacyOriginal(), raw);
      assert.equal(storage.getItem(LEGACY_KEY), raw);
      assert.equal(storage.getItem(MIGRATION_KEY), null);
      assert.equal(page.getState().legacy.migrated, false);
    });
  }
});

test("corrupted legacy bytes remain downloadable and never block canonical loading or unrelated edits", async () => {
  const original = " {not valid JSON}\r\n\u0000";
  const storage = memory([[LEGACY_KEY, original]]), api = server([plan("canonical-plan")]), page = client(api, storage);
  await page.ready();
  assert.equal(page.getState().legacy.valid, false);
  assert.match(page.getState().legacy.error, /no es válida/);
  assert.equal(page.getLegacyOriginal(), original);
  await page.refresh();
  await assert.rejects(page.shareLegacy(), { code: "invalid" });
  const base = page.getSnapshot();
  await page.save(base, [...base.events, plan("still-editable")]);
  assert.equal(api.current.events[0].id, "canonical-plan");
  assert.equal(api.current.events[1].id, "still-editable");
  assert.equal(storage.getItem(LEGACY_KEY), original);
  assert.equal(page.getLegacyOriginal(), original);
});

test("a failed migration marker write reports only a backup limitation after a successful shared migration", async () => {
  const old = [...clone(Trip.SEED), plan("old-browser-plan")];
  const raw = JSON.stringify({ version: 1, language: "es", events: old });
  const storage = memory([[LEGACY_KEY, raw]], key => key === MIGRATION_KEY), api = server(Trip.SEED), page = client(api, storage);
  await page.ready();
  const result = await page.shareLegacy();
  assert.equal(result.written, true);
  assert.equal(page.getState().legacy.migrated, true);
  assert.equal(page.getState().status, "shared");
  assert.match(page.getState().backupWarning, /no se pudo registrar/);
  assert.ok(api.current.events.some(event => event.id === "old-browser-plan"));
  assert.equal(storage.getItem(LEGACY_KEY), raw);
});
