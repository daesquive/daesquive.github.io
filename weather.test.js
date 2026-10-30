"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { WeatherError, loadWeather, forecastUrl } = require("./weather.js");
const now = Date.parse("2026-10-30T02:00:00Z");
const sample = () => [0, -2.5, 18.4, 20.1, 11.6].map((temperature, index) => ({
  current_units: { temperature_2m: "°C" },
  current: { temperature_2m: temperature, weather_code: index === 1 ? 61 : 3, time: now / 1000 - 300 }
}));
const response = data => ({ ok: true, json: async () => data });
const get = (data, options = {}) => loadWeather({ fetch: async () => response(data), now: () => now, ...options });

test("one credential-free request maps current Celsius weather to the five requested cities and their forecast maps", async () => {
  let coordinates;
  const rows = await get(sample(), {
    fetch: async (url, options) => {
      const request = new URL(url);
      assert.equal(request.origin, "https://api.open-meteo.com");
      assert.equal(request.searchParams.get("current"), "temperature_2m,weather_code");
      assert.equal(request.searchParams.get("temperature_unit"), "celsius");
      assert.equal(request.searchParams.get("timeformat"), "unixtime");
      assert.equal(request.searchParams.get("latitude").split(",").length, 5);
      assert.equal(request.searchParams.get("longitude").split(",").length, 5);
      coordinates = request.searchParams.get("latitude").split(",").map((lat, index) => [
        Number(lat), Number(request.searchParams.get("longitude").split(",")[index])
      ]);
      assert.equal(request.searchParams.has("apikey"), false);
      assert.equal(options.cache, "no-store");
      assert.equal(options.credentials, "omit");
      return response(sample());
    }
  });
  assert.deepEqual(rows.map(row => row.city.name), ["Madrid", "Lisboa", "Sevilla", "Gibraltar", "Granada"]);
  assert.deepEqual(rows.map(row => row.temperature), [0, -2.5, 18.4, 20.1, 11.6]);
  assert.equal(rows[1].condition, "Lluvia débil");
  for (const [index, row] of rows.entries()) {
    const link = new URL(forecastUrl(row.city));
    const [lat, lon] = link.pathname.slice(1).split("/").map(Number);
    assert.equal(link.origin, "https://www.windy.com");
    assert.equal(lat, row.city.lat);
    assert.equal(lon, row.city.lon);
    assert.deepEqual(coordinates[index], [lat, lon]);
    assert.equal(link.search, `?temp,${row.city.lat.toFixed(4)},${row.city.lon.toFixed(4)},10`);
  }
});

test("invalid units, missing temperatures and stale city data are explicit and cannot hide the valid cities", async () => {
  const data = sample();
  data[0].current_units.temperature_2m = "°F";
  data[1].current.temperature_2m = null;
  data[2].current.time -= 7200;
  const rows = await get(data);
  assert.match(rows[0].error, /no disponibles/);
  assert.match(rows[1].error, /no disponibles/);
  assert.match(rows[2].error, /recientes/);
  assert.equal(rows[3].temperature, 20.1);
  assert.equal(rows[4].temperature, 11.6);
  assert.equal(Object.hasOwn(rows[0], "temperature"), false);
});

test("future or missing timestamps are rejected and unknown conditions are labeled without inventing weather", async () => {
  const data = sample();
  data[0].current.time += 7200;
  delete data[1].current.time;
  data[2].current.weather_code = 999;
  const rows = await get(data);
  assert.match(rows[0].error, /recientes/);
  assert.ok(rows[1].error);
  assert.equal(rows[2].temperature, 18.4);
  assert.equal(rows[2].condition, "Estado no disponible");
  assert.equal(rows[2].warning, true);
});

test("malformed batches and service failures never become successful or zero-degree weather", async () => {
  for (const data of [null, {}, sample().slice(1), [...sample(), sample()[0]]]) {
    await assert.rejects(get(data), WeatherError);
  }
  for (const status of [429, 503]) {
    await assert.rejects(get(null, { fetch: async () => ({ ok: false, status }) }), error => error instanceof WeatherError && error.message.includes(`HTTP ${status}`));
  }
  await assert.rejects(get(null, { fetch: async () => { throw new TypeError("disconnected"); } }), { name: "WeatherError", message: "No se pudo conectar con el servicio meteorológico." });
  await assert.rejects(get(null, { fetch: async () => ({ ok: true, json: async () => { throw new SyntaxError("bad JSON"); } }) }), { name: "WeatherError", message: "El servicio meteorológico devolvió una respuesta inválida." });
});

test("the weather timeout covers a stalled response body rather than leaving the widget loading forever", async () => {
  await assert.rejects(get(null, {
    timeoutMs: 5,
    fetch: async (url, options) => ({
      ok: true,
      json: () => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      })
    })
  }), { name: "WeatherError", message: "Se agotó el tiempo de consulta del tiempo." });
});
