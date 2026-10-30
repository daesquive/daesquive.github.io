(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./data.js"));
  else factory(root.Trip).mount(root);
})(typeof globalThis !== "undefined" ? globalThis : this, function (Trip) {
  "use strict";
  const REFRESH_MS = 15 * 60 * 1000;
  const CITIES = ["madrid", "lisbon", "seville", "gibraltar", "granada"].map(id => {
    const stop = Trip.STOPS.find(city => city.id === id);
    return id === "gibraltar"
      ? { id, name: "Gibraltar", lat: 36.1408, lon: -5.3536 }
      : { id, name: stop.name, lat: stop.lat, lon: stop.lon };
  });
  const CONDITIONS = {
    0: "Despejado", 1: "Mayormente despejado", 2: "Parcialmente nublado", 3: "Nublado",
    45: "Niebla", 48: "Niebla con escarcha",
    51: "Llovizna débil", 53: "Llovizna", 55: "Llovizna intensa",
    56: "Llovizna helada", 57: "Llovizna helada intensa",
    61: "Lluvia débil", 63: "Lluvia", 65: "Lluvia intensa",
    66: "Lluvia helada", 67: "Lluvia helada intensa",
    71: "Nieve débil", 73: "Nieve", 75: "Nieve intensa", 77: "Granos de nieve",
    80: "Chubascos débiles", 81: "Chubascos", 82: "Chubascos intensos",
    85: "Chubascos de nieve", 86: "Chubascos de nieve intensos",
    95: "Tormenta", 96: "Tormenta con granizo", 97: "Tormenta fuerte", 99: "Tormenta con granizo intenso"
  };
  const endpoint = new URL("https://api.open-meteo.com/v1/forecast");
  endpoint.search = new URLSearchParams({
    latitude: CITIES.map(city => city.lat).join(","),
    longitude: CITIES.map(city => city.lon).join(","),
    current: "temperature_2m,weather_code",
    temperature_unit: "celsius",
    timeformat: "unixtime"
  }).toString();

  class WeatherError extends Error {
    constructor(message) { super(message); this.name = "WeatherError"; }
  }

  function forecastUrl(city) {
    const lat = city.lat.toFixed(4), lon = city.lon.toFixed(4);
    return `https://www.windy.com/${lat}/${lon}?temp,${lat},${lon},10`;
  }

  async function loadWeather(options = {}) {
    const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
    let payload;
    try {
      const response = await fetcher(endpoint.href, {
        cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal
      });
      if (!response.ok) throw new WeatherError(`El servicio meteorológico no está disponible (HTTP ${response.status}).`);
      payload = await response.json();
    } catch (error) {
      if (error instanceof WeatherError) throw error;
      if (error.name === "AbortError") throw new WeatherError("Se agotó el tiempo de consulta del tiempo.");
      if (error instanceof SyntaxError) throw new WeatherError("El servicio meteorológico devolvió una respuesta inválida.");
      if (error instanceof TypeError) throw new WeatherError("No se pudo conectar con el servicio meteorológico.");
      throw error;
    } finally { clearTimeout(timer); }
    if (!Array.isArray(payload) || payload.length !== CITIES.length) {
      throw new WeatherError("El servicio no devolvió datos válidos para las cinco ciudades.");
    }
    const now = (options.now || Date.now)();
    return payload.map((location, index) => {
      const city = CITIES[index], current = location?.current;
      if (location?.current_units?.temperature_2m !== "°C" ||
          !Number.isFinite(current?.temperature_2m) || !Number.isFinite(current?.time)) {
        return { city, error: "Datos no disponibles" };
      }
      const observedAt = current.time * 1000;
      if (observedAt < now - 60 * 60 * 1000 || observedAt > now + REFRESH_MS) {
        return { city, error: "Sin datos recientes" };
      }
      const knownCondition = Number.isInteger(current.weather_code) && Object.hasOwn(CONDITIONS, current.weather_code);
      return {
        city, temperature: current.temperature_2m, observedAt,
        condition: knownCondition ? CONDITIONS[current.weather_code] : "Estado no disponible",
        warning: !knownCondition
      };
    });
  }

  function mount(root) {
    const document = root.document;
    const panel = document.getElementById("weather-panel");
    const status = document.getElementById("weather-status");
    const body = document.getElementById("weather-rows");
    const number = new Intl.NumberFormat("es", { maximumFractionDigits: 1 });
    const date = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const rows = CITIES.map(city => {
      const row = document.createElement("tr");
      const heading = document.createElement("th");
      heading.scope = "row";
      const link = document.createElement("a");
      link.href = forecastUrl(city); link.textContent = city.name;
      link.target = "_blank"; link.rel = "noopener noreferrer";
      link.title = `Ver pronóstico y mapa de ${city.name} en otra pestaña`;
      heading.append(link);
      const temperature = document.createElement("td");
      temperature.className = "weather-temperature";
      temperature.textContent = "…";
      const condition = document.createElement("td");
      condition.textContent = "Cargando…";
      row.append(heading, temperature, condition);
      return { row, temperature, condition };
    });
    body.replaceChildren(...rows.map(item => item.row));
    let loading = false, lastAttempt = -Infinity, lastStamp = "";
    function setStatus(state, message) {
      panel.dataset.state = state;
      status.textContent = message;
    }
    function reportFailure(message) {
      if (lastStamp) setStatus("stale", `${message} Datos anteriores: ${lastStamp}.`);
      else {
        rows.forEach(item => { item.temperature.textContent = "—"; item.condition.textContent = "No disponible"; });
        setStatus("error", message);
      }
    }
    async function refresh(force = false) {
      if (document.visibilityState === "hidden" || loading || (!force && Date.now() - lastAttempt < REFRESH_MS)) return;
      if (root.navigator.onLine === false) { reportFailure("Sin conexión para actualizar el tiempo."); return; }
      loading = true;
      lastAttempt = Date.now();
      panel.setAttribute("aria-busy", "true");
      setStatus("loading", "Actualizando el tiempo…");
      try {
        const results = await loadWeather({ fetch: root.fetch.bind(root) });
        results.forEach((result, index) => {
          rows[index].temperature.textContent = result.error ? "—" : `${number.format(result.temperature)} °C`;
          rows[index].condition.textContent = result.error || result.condition;
        });
        const available = results.filter(result => !result.error);
        lastStamp = available.length ? date.format(Math.min(...available.map(result => result.observedAt))) : "";
        if (!available.length) setStatus("error", "No hay datos meteorológicos recientes. Podés abrir el pronóstico de cada ciudad.");
        else if (results.some(result => result.error || result.warning)) setStatus("partial", `Hay datos no disponibles. Última actualización: ${lastStamp}.`);
        else setStatus("current", `Actualizado ${lastStamp}. Cada 15 min.`);
      } catch (error) {
        if (!(error instanceof WeatherError)) throw error;
        reportFailure(error.message);
      } finally {
        loading = false;
        panel.setAttribute("aria-busy", "false");
      }
    }
    root.addEventListener("online", () => refresh(true));
    root.addEventListener("offline", () => reportFailure("Sin conexión para actualizar el tiempo."));
    root.addEventListener("focus", () => refresh());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
    root.setInterval(() => refresh(), REFRESH_MS);
    refresh(true);
  }
  return { WeatherError, loadWeather, forecastUrl, mount };
});
