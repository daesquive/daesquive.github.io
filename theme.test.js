const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const { createHash } = require("node:crypto");
const source = readFileSync(join(__dirname, "theme.js"), "utf8");
const KEY = "atlas-iberia-theme-v1";

function browser(saved = null, readError = null, writeError = null) {
  const stored = new Map([["itinerary", "do not change"]]);
  if (saved !== null) stored.set(KEY, saved);
  const handlers = {};
  const button = {
    textContent: "", attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { handlers[name] = callback; }
  };
  const status = { textContent: "" };
  const meta = { content: "" };
  const root = { dataset: {} };
  const document = {
    documentElement: root,
    querySelector: () => meta,
    getElementById: id => id === "theme-toggle" ? button : status,
    addEventListener(name, callback) { handlers[name] = callback; }
  };
  runInNewContext(source, {
    document,
    localStorage: {
      getItem(key) { if (readError) throw readError; return stored.get(key) ?? null; },
      setItem(key, value) { if (writeError) throw writeError; stored.set(key, value); }
    }
  });
  return { root, meta, button, status, stored, ready: () => handlers.DOMContentLoaded(), toggle: () => handlers.click() };
}

test("light remains the default and a saved dark preference is restored before the page is ready", () => {
  assert.equal(browser().root.dataset.theme, "light");
  const page = browser("dark");
  assert.equal(page.root.dataset.theme, "dark");
  page.ready();
  assert.equal(page.button.attributes["aria-label"], "Cambiar a modo claro");
});

test("the switch saves both directions without touching itinerary storage", () => {
  const page = browser();
  page.ready();
  page.toggle();
  assert.equal(page.root.dataset.theme, "dark");
  assert.equal(page.stored.get(KEY), "dark");
  assert.equal(page.button.textContent, "Modo claro");
  page.toggle();
  assert.equal(page.root.dataset.theme, "light");
  assert.equal(page.stored.get(KEY), "light");
  assert.equal(page.stored.get("itinerary"), "do not change");
});

test("blocked storage is explained and changing the theme still works for the current visit", () => {
  const blockedRead = browser(null, new DOMException("Denied", "SecurityError"));
  blockedRead.ready();
  assert.match(blockedRead.status.textContent, /No se pudo leer/);
  const blockedWrite = browser(null, null, new DOMException("Full", "QuotaExceededError"));
  blockedWrite.ready();
  blockedWrite.toggle();
  assert.equal(blockedWrite.root.dataset.theme, "dark");
  assert.match(blockedWrite.status.textContent, /solo para esta visita/);
  assert.equal(blockedWrite.stored.has(KEY), false);
});

test("an invalid saved preference is reported, not overwritten until a mode is chosen", () => {
  const page = browser("broken");
  page.ready();
  assert.match(page.status.textContent, /no es válida/);
  assert.equal(page.stored.get(KEY), "broken");
  page.toggle();
  assert.equal(page.stored.get(KEY), "dark");
});

test("asset URLs change with their content so cached files cannot hide application updates", () => {
  const html = readFileSync(join(__dirname, "index.html"), "utf8");
  for (const asset of ["style.css", "theme.js", "app.js", "data.js", "sync.js", "weather.js"]) {
    const content = readFileSync(join(__dirname, asset), "utf8").replace(/\r\n/g, "\n");
    const version = createHash("sha256").update(content).digest("hex").slice(0, 12);
    const reference = html.match(new RegExp(`(?:src|href)="${asset.replace(".", "\\.")}\\?v=([a-f0-9]+)"`));
    assert.ok(reference, `${asset} needs a versioned URL`);
    assert.equal(reference[1], version, `Update the URL version after changing ${asset}`);
  }
});
