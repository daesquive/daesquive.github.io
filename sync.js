(function (root, factory) {
  "use strict";
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./data.js"));
  else root.TripSync = factory(root.Trip);
})(typeof globalThis !== "undefined" ? globalThis : this, function (Trip) {
  "use strict";
  const LEGACY_KEY = "atlas-iberia-november-2026-v1";
  const CACHE_KEY = "atlas-iberia-shared-cache-v1";
  const MIGRATION_KEY = "atlas-iberia-shared-migrations-v1";
  const clone = value => JSON.parse(JSON.stringify(value));
  const stable = value => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  const equal = (left, right) => stable(left) === stable(right);
  const equalEvents = (left, right) => equal([...left].sort((a, b) => a.id.localeCompare(b.id)), [...right].sort((a, b) => a.id.localeCompare(b.id)));

  class SyncError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "SyncError";
      this.code = code;
      Object.assign(this, details);
    }
  }

  function readBackup(backup) {
    if (!backup || backup.version !== 1) throw new SyncError("invalid", "La versión de la copia no es compatible.");
    const events = Trip.validateEvents(backup.events);
    return clone(backup.language === "es" ? events : Trip.migrateSpanish(events));
  }

  function validateSnapshot(value) {
    if (!value || value.version !== 1 || value.language !== "es" || !Number.isSafeInteger(value.revision) || value.revision < 0) {
      throw new SyncError("response", "La respuesta compartida no es válida. No se reemplazaron los planes ni se enviaron datos de respaldo.");
    }
    try { Trip.validateEvents(value.events); }
    catch {
      throw new SyncError("response", "El calendario compartido contiene planes inválidos. Se conservó la última copia válida; no se reemplazó el servidor.");
    }
    return { version: 1, language: "es", revision: value.revision, events: clone(value.events) };
  }

  function mergeEvents(base, desired, current) {
    Trip.validateEvents(base);
    Trip.validateEvents(desired);
    Trip.validateEvents(current);
    const before = new Map(base.map(event => [event.id, event]));
    const after = new Map(desired.map(event => [event.id, event]));
    const latest = new Map(current.map(event => [event.id, event]));
    const conflicts = [];
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const old = before.get(id), next = after.get(id), remote = latest.get(id);
      if (equal(old, next)) continue;
      // An identical remote result also covers a retry after a lost PUT response.
      if (!equal(remote, old) && !equal(remote, next)) {
        conflicts.push({ id, title: next?.title || old?.title || id });
        continue;
      }
      if (next) latest.set(id, next);
      else latest.delete(id);
    }
    if (conflicts.length) {
      const names = conflicts.slice(0, 3).map(event => `«${event.title}»`).join(", ");
      throw new SyncError("conflict", `Otro dispositivo cambió o eliminó ${names}. No se guardaron tus cambios. Se actualizó el calendario visible; tu copia o texto se conserva. Copiá lo necesario y cerrá y reabrí el plan actualizado antes de combinarlo.`, { conflicts });
    }
    return clone(Trip.validateEvents([...latest.values()]));
  }

  async function fingerprint(raw) {
    if (!globalThis.crypto?.subtle) return `original:${raw}`;
    const bytes = new Uint8Array(raw.length * 2);
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i);
      bytes[i * 2] = code & 255;
      bytes[i * 2 + 1] = code >> 8;
    }
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  function createClient(options = {}) {
    let storage = null;
    try { storage = Object.hasOwn(options, "storage") ? options.storage : globalThis.localStorage; } catch { /* Shared saves do not require browser storage. */ }
    const fetcher = options.fetch || globalThis.fetch?.bind(globalThis);
    const listeners = new Set();
    const warnings = new Map();
    const migrated = new Set();
    let cache = null, canonical = null, cacheBlocked = false, markersBlocked = false;
    let saving = false, refreshing = false, refreshPromise = null, generation = 0;
    let lastRefresh = -Infinity, legacySequence = 0, legacyReady;
    let legacy = { raw: null, events: null, hasChanges: false, migrated: false, checking: false, error: "" };
    let status = "loading", message = "Cargando el calendario compartido…";
    let endpoint, configError;
    try {
      if (typeof options.url !== "string" || !options.url.trim()) throw new Error();
      const url = new URL(options.url);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) throw new Error();
      endpoint = url.href;
    } catch {
      configError = new SyncError("config", "Falta una dirección válida del calendario compartido. No se pueden confirmar guardados; avisá a quien administra la página.");
    }

    function getSnapshot() { return canonical || cache ? clone(canonical || cache) : null; }
    function getState() {
      return {
        snapshot: getSnapshot(), source: canonical ? "server" : cache ? "cache" : "none",
        status, message, saving, refreshing, backupWarning: [...warnings.values()].join(" "),
        legacy: {
          available: legacy.raw !== null, valid: !!legacy.events, hasChanges: legacy.hasChanges,
          migrated: legacy.migrated, checking: legacy.checking, error: legacy.error,
          count: legacy.events?.length || 0
        }
      };
    }
    function emit() { for (const listener of listeners) listener(getState()); }
    function setStatus(next, text) { status = next; message = text; }
    function readMarkers() {
      if (!storage) return;
      try {
        const raw = storage.getItem(MIGRATION_KEY);
        if (raw === null) return;
        const parsed = JSON.parse(raw);
        if (parsed.version !== 1 || !Array.isArray(parsed.completed) || !parsed.completed.every(id => typeof id === "string")) throw new Error();
        parsed.completed.forEach(id => migrated.add(id));
      } catch {
        markersBlocked = true;
        warnings.set("markers", "No se pudo leer el registro de copias ya compartidas. Se conservó intacto; el aviso de planes anteriores puede reaparecer.");
      }
    }
    if (!storage) warnings.set("storage", "Este navegador no permite copias locales. El guardado compartido sigue disponible con internet; descargá una copia JSON para respaldo.");
    else {
      try {
        const raw = storage.getItem(CACHE_KEY);
        if (raw !== null) cache = validateSnapshot(JSON.parse(raw));
      } catch {
        cacheBlocked = true;
        warnings.set("cache", "La copia sin conexión no se pudo leer o no es válida y se conservó intacta. Solo se usarán datos válidos del servidor; descargá una copia JSON de respaldo.");
      }
    }
    if (cache) setStatus("offline", "Copia sin conexión, todavía sin verificar. Buscando el calendario compartido…");
    readMarkers();

    async function checkLegacy() {
      const sequence = ++legacySequence;
      readMarkers();
      let raw = null;
      try { raw = storage ? storage.getItem(LEGACY_KEY) : null; }
      catch {
        warnings.set("legacy", "No se pudo leer la copia anterior de este navegador. No se modificó; revisá los permisos para poder recuperarla.");
        emit();
        return;
      }
      if (raw === null) {
        legacy = { raw: null, events: null, hasChanges: false, migrated: false, checking: false, error: "" };
        emit();
        return;
      }
      try {
        const events = readBackup(JSON.parse(raw));
        legacy = { raw, events, hasChanges: !equalEvents(events, Trip.SEED), migrated: false, checking: true, error: "" };
      } catch {
        legacy = { raw, events: null, hasChanges: false, migrated: false, checking: false, error: "La copia anterior no es válida. No se modificó ni se envió al servidor. Descargá el original para recuperarlo." };
        emit();
        return;
      }
      emit();
      let id;
      try { id = await fingerprint(raw); }
      catch { id = `original:${raw}`; }
      if (sequence !== legacySequence) return;
      legacy.fingerprint = id;
      legacy.migrated = migrated.has(id);
      legacy.checking = false;
      emit();
    }

    function cacheSnapshot(snapshot) {
      if (!storage || cacheBlocked) return;
      try {
        const serialized = JSON.stringify(snapshot);
        if (storage.getItem(CACHE_KEY) !== serialized) storage.setItem(CACHE_KEY, serialized);
        warnings.delete("cache-write");
      } catch {
        warnings.set("cache-write", "No se pudo guardar una copia sin conexión en este navegador. Esto NO impide guardar en el calendario compartido; descargá una copia JSON para respaldo.");
      }
    }
    function accept(snapshot) {
      if (canonical && snapshot.revision < canonical.revision) return canonical;
      if (canonical && snapshot.revision === canonical.revision && !equalEvents(snapshot.events, canonical.events)) {
        throw new SyncError("response", "El servidor devolvió datos diferentes para la misma revisión. Se conservó la última versión confirmada; intentá actualizar más tarde.");
      }
      canonical = clone(snapshot);
      cacheSnapshot(canonical);
      emit();
      return canonical;
    }
    async function request(method, body, passphrase) {
      if (configError) throw configError;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
      const headers = { Accept: "application/json" };
      if (method === "PUT") {
        headers["Content-Type"] = "application/json";
        headers["X-Family-Passphrase"] = passphrase;
      }
      try {
        const response = await fetcher(endpoint, {
          method, headers, body, cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal
        });
        let data;
        if (response.ok || response.status === 409) {
          try { data = await response.json(); }
          catch (error) {
            if (error instanceof SyntaxError) throw new SyncError("response", "No se pudo verificar la respuesta del servidor. Conservá tu texto y reintentá; no se mostró el cambio como guardado.");
            throw error;
          }
        }
        return { ok: response.ok, status: response.status, data };
      } catch (error) {
        if (error instanceof SyncError) throw error;
        throw new SyncError("network", method === "PUT"
          ? "No se pudo confirmar el guardado por un problema de conexión. Conservá el texto y reintentá: se mantendrá el mismo identificador para no duplicar el plan."
          : "Sin conexión con el calendario compartido. La copia visible es solo de lectura sin verificar; necesitás internet para confirmar cambios.");
      } finally { clearTimeout(timer); }
    }
    function httpError(response) {
      const messages = {
        400: "El servidor rechazó los datos. Revisá los planes antes de reintentar; no se confirmó ningún cambio.",
        401: "La contraseña familiar no es correcta. Volvé a guardar para ingresarla de nuevo; tu texto se conserva.",
        413: "La copia supera el límite compartido de 1 MiB. Reducí las notas o la cantidad de planes antes de reintentar.",
        503: "El calendario compartido no está disponible o todavía no está configurado. No se confirmó el guardado; intentá más tarde."
      };
      return new SyncError(response.status === 401 ? "auth" : "http", messages[response.status] || `El servidor no pudo completar la operación (HTTP ${response.status}). No se confirmó ningún cambio.`, { status: response.status });
    }
    async function getLatest() {
      const response = await request("GET");
      if (!response.ok) throw httpError(response);
      return validateSnapshot(response.data);
    }
    function report(error) { setStatus(error.code === "network" ? "offline" : error.code === "conflict" ? "conflict" : "error", error.message); }

    function refresh({ force = false } = {}) {
      if (saving) return Promise.resolve(getSnapshot());
      if (refreshPromise) return refreshPromise;
      if (!force && Date.now() - lastRefresh < (options.refreshFloorMs ?? 1500)) return Promise.resolve(getSnapshot());
      lastRefresh = Date.now();
      const started = generation;
      refreshing = true;
      if (!canonical && !cache) setStatus("loading", "Cargando el calendario compartido…");
      emit();
      refreshPromise = (async () => {
        try {
          const snapshot = await getLatest();
          // A refresh begun before a write must not change that write's state or status.
          if (started === generation && !saving) {
            accept(snapshot);
            setStatus("shared", "Calendario compartido al día. Los cambios aparecen automáticamente en los demás dispositivos.");
          }
          return getSnapshot();
        } catch (error) {
          if (started === generation && !saving) report(error);
          throw error;
        } finally {
          refreshing = false;
          refreshPromise = null;
          emit();
        }
      })();
      return refreshPromise;
    }

    async function save(base, desired) {
      if (saving) throw new SyncError("busy", "Ya hay un guardado en curso. Esperá su confirmación.");
      const original = validateSnapshot(base);
      const draft = clone(Trip.validateEvents(desired));
      saving = true;
      generation++;
      setStatus("saving", "Guardando en el calendario compartido…");
      emit();
      try {
        let latest = accept(await getLatest());
        let passphrase;
        for (let attempt = 0; attempt <= 3; attempt++) {
          const merged = mergeEvents(original.events, draft, latest.events);
          if (equalEvents(merged, latest.events)) {
            setStatus("shared", "Cambios confirmados en el calendario compartido.");
            return { snapshot: getSnapshot(), written: false };
          }
          if (attempt === 3) throw new SyncError("busy", "El calendario cambió varias veces durante el guardado. No se confirmó tu cambio; conservá el texto y reintentá cuando terminen los otros cambios.");
          const body = JSON.stringify({ version: 1, language: "es", revision: latest.revision, events: merged });
          if (new TextEncoder().encode(body).length > 1024 * 1024) throw new SyncError("http", "La copia supera el límite compartido de 1 MiB. Reducí las notas o la cantidad de planes antes de reintentar.", { status: 413 });
          if (passphrase === undefined) {
            passphrase = await options.getPassphrase?.();
            if (typeof passphrase !== "string" || !passphrase) throw new SyncError("cancelled", "Guardado cancelado: no se envió ningún cambio. Tu texto o copia se conserva para reintentar.");
          }
          const response = await request("PUT", body, passphrase);
          if (response.status === 409) {
            const current = validateSnapshot(response.data?.current);
            if (current.revision <= latest.revision) throw new SyncError("response", "El servidor no devolvió una revisión más reciente para resolver el conflicto. Se conservó tu trabajo; actualizá y reintentá.");
            latest = accept(current);
            continue;
          }
          if (!response.ok) {
            if (response.status === 401) options.onUnauthorized?.();
            throw httpError(response);
          }
          const confirmed = validateSnapshot(response.data);
          if (confirmed.revision <= latest.revision || !equalEvents(confirmed.events, merged)) {
            throw new SyncError("response", "El servidor no confirmó los planes enviados. Conservá tu texto y reintentá sin crear otro plan.");
          }
          accept(confirmed);
          setStatus("shared", "Guardado confirmado en el calendario compartido. Se actualizará en los demás dispositivos.");
          return { snapshot: getSnapshot(), written: true };
        }
      } catch (error) {
        report(error);
        throw error;
      } finally {
        saving = false;
        emit();
      }
    }

    async function shareLegacy() {
      await legacyReady;
      if (!legacy.events) throw new SyncError("invalid", legacy.error || "No hay una copia anterior válida para compartir.");
      if (!legacy.hasChanges || legacy.migrated) return { snapshot: getSnapshot(), written: false, skipped: true };
      const original = { raw: legacy.raw, fingerprint: legacy.fingerprint, events: clone(legacy.events) };
      const result = await save({ version: 1, language: "es", revision: 0, events: clone(Trip.SEED) }, original.events);
      migrated.add(original.fingerprint);
      if (storage && !markersBlocked) {
        try {
          readMarkers();
          if (!markersBlocked) storage.setItem(MIGRATION_KEY, JSON.stringify({ version: 1, completed: [...migrated] }));
        } catch {
          warnings.set("markers-write", "Los planes se compartieron, pero no se pudo registrar la migración en este navegador. El aviso podría reaparecer; la copia original sigue intacta.");
        }
      } else {
        warnings.set("markers-write", "Los planes se compartieron, pero el aviso puede reaparecer porque no se pudo guardar el registro local. La copia original no se modificó.");
      }
      if (legacy.raw === original.raw) legacy.migrated = true;
      emit();
      return result;
    }

    legacyReady = checkLegacy();
    return {
      getSnapshot, getState, refresh, save, shareLegacy,
      getLegacyOriginal: () => legacy.raw,
      checkLegacy() { legacyReady = checkLegacy(); return legacyReady; },
      ready: () => legacyReady,
      markOffline() {
        if (!saving) {
          setStatus("offline", "Sin conexión. El calendario visible es una copia de lectura; necesitás internet para confirmar los cambios compartidos.");
          emit();
        }
      },
      subscribe(listener) { listeners.add(listener); listener(getState()); return () => listeners.delete(listener); }
    };
  }
  return { LEGACY_KEY, CACHE_KEY, MIGRATION_KEY, SyncError, readBackup, validateSnapshot, mergeEvents, createClient };
});
