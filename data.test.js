"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SEED, LEGACY_SEED, migrateSpanish, validateEvents, eventsOn, localInstant, buildICS } = require("./data.js");
const clone = value => JSON.parse(JSON.stringify(value));

test("the provided itinerary is valid and stays occupy nights, not checkout nights", () => {
  validateEvents(SEED);
  const stay = SEED.find(e => e.id === "seed-05-13");
  assert.ok(eventsOn(SEED, "2026-11-07").includes(stay));
  assert.ok(!eventsOn(SEED, "2026-11-08").includes(stay));
  const madrid = SEED.find(e => e.id === "seed-14-42");
  assert.ok(eventsOn(SEED, "2026-11-18").includes(madrid));
  assert.ok(!eventsOn(SEED, "2026-11-19").includes(madrid));
});

test("local times resolve independently of the browser zone across the three countries", () => {
  assert.equal(new Date(localInstant("2026-11-03", "17:25", "America/Costa_Rica")).toISOString(), "2026-11-03T23:25:00.000Z");
  assert.equal(new Date(localInstant("2026-11-04", "10:15", "Europe/Madrid")).toISOString(), "2026-11-04T09:15:00.000Z");
  assert.equal(new Date(localInstant("2026-11-08", "08:00", "Europe/Lisbon")).toISOString(), "2026-11-08T08:00:00.000Z");
  assert.equal(new Date(localInstant("2026-11-19", "15:45", "America/Costa_Rica")).toISOString(), "2026-11-19T21:45:00.000Z");
  assert.equal(new Date(localInstant("2026-11-11", "", "Europe/Gibraltar")).toISOString(), "2026-11-11T08:00:00.000Z");
});

test("calendar export uses UTC for flights and exclusive all-day end dates", () => {
  const text = buildICS(SEED, Date.UTC(2026, 9, 28));
  assert.match(text, /DTSTART:20261103T232500Z/);
  assert.match(text, /DTSTART:20261104T091500Z/);
  assert.match(text, /DTSTART:20261119T214500Z/);
  assert.match(text, /DTSTART;VALUE=DATE:20261105\r\nDTEND;VALUE=DATE:20261108/);
  assert.match(text, /DTSTART;VALUE=DATE:20261114\r\nDTEND;VALUE=DATE:20261119/);
  assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, SEED.length);
});

test("export escapes notes, folds UTF-8 safely, preserves stable IDs and reminder instants", () => {
  const event = { ...clone(SEED[0]), title: "Lisbon, family; trip", notes: "Line 1\nLine 2\\end " + "á".repeat(90), reminder: 60 };
  const text = buildICS([event], 0);
  assert.match(text, /SUMMARY:Lisbon\\, family\\; trip/);
  assert.match(text, /Line 1\\nLine 2\\\\end/);
  assert.match(text, /TRIGGER;VALUE=DATE-TIME:20261103T180000Z/);
  assert.ok(text.includes(`UID:${event.id}@iberian-november.local`));
  assert.ok(text.split("\r\n").every(line => Buffer.byteLength(line, "utf8") <= 75));
  event.done = true;
  assert.ok(!buildICS([event]).includes("BEGIN:VEVENT"));
});

test("bad imports are rejected instead of partially replacing itinerary data", () => {
  for (const change of [
    { date: "2026-11-31" }, { endDate: "2026-10-31" }, { time: "25:00" },
    { url: "javascript:alert(1)" }, { status: "booked-ish" }, { reminder: "60" },
    { zone: "not-a-zone" }, { endTime: "12:00", time: "" },
    { stay: "hotel", type: "activity" }, { title: "" },
    { id: "injected\r\nBEGIN:VEVENT" }, { url: "https://example.com/\r\nBEGIN:VEVENT" }
  ]) {
    assert.throws(() => validateEvents([{ ...clone(SEED[0]), ...change }]));
  }
  assert.throws(() => validateEvents([clone(SEED[0]), clone(SEED[0])]));
  assert.doesNotThrow(() => validateEvents([]));
});

test("untimed reminders use 09:00 in the event zone, and November 30 exports into December", () => {
  const event = { ...clone(SEED[0]), date: "2026-11-30", endDate: "2026-11-30", time: "", zone: "Europe/Lisbon", reminder: 60 };
  const text = buildICS([event]);
  assert.match(text, /DTSTART;VALUE=DATE:20261130\r\nDTEND;VALUE=DATE:20261201/);
  assert.match(text, /TRIGGER;VALUE=DATE-TIME:20261130T080000Z/);
});

test("Spanish migration translates only untouched text and preserves custom events, edits and deletions", () => {
  const edited = { ...clone(LEGACY_SEED[0]), title: "Mi taxi particular", time: "12:45", done: true };
  const custom = { ...clone(LEGACY_SEED[1]), id: "my-custom-plan", title: "My own English text", notes: "Do not replace" };
  const original = [edited, clone(LEGACY_SEED[3]), custom];
  const migrated = migrateSpanish(original);
  assert.equal(migrated.length, original.length);
  assert.equal(migrated[0].title, edited.title);
  assert.equal(migrated[0].time, "12:45");
  assert.equal(migrated[0].done, true);
  assert.equal(migrated[0].notes, SEED[0].notes);
  assert.equal(migrated[1].title, "Llegada a Madrid - Iberia IB0244");
  assert.deepEqual(migrated[2], custom);
  assert.equal(original[1].title, LEGACY_SEED[3].title);
  assert.deepEqual(migrateSpanish(SEED), SEED);
});

test("all initial plans have Spanish titles and exports show Spanish statuses and notes", () => {
  assert.equal(SEED.length, 51);
  assert.ok(SEED.every((e, i) => e.title !== LEGACY_SEED[i].title));
  assert.deepEqual(migrateSpanish(LEGACY_SEED), SEED);
  const text = buildICS([SEED[0]], 0).replace(/\r\n /g, "");
  assert.match(text, /SUMMARY:Recogida del taxi/);
  assert.match(text, /Estado: Reservado/);
  assert.match(text, /Zona horaria:/);
  assert.ok(!text.includes("Default duration"));
});
