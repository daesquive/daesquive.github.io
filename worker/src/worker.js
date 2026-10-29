import Trip from "../../data.js";

const ALLOWED_ORIGINS = new Set([
  "https://daesquive.github.io",
  "http://127.0.0.1:8788",
  "http://localhost:8788"
]);
const METHODS = "GET, PUT, OPTIONS";
// Older tabs may still send the obsolete passphrase header.
const ALLOWED_HEADERS = new Set(["content-type", "x-family-passphrase"]);
const MAX_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const READ_AGENDA = "SELECT revision, events FROM agenda WHERE id = 1";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(body, status, headers) {
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

async function readJson(request) {
  if (Number(request.headers.get("Content-Length")) > MAX_BYTES) {
    request.body?.cancel().catch(() => {});
    throw new HttpError(413, "La agenda supera el límite de 1 MiB.");
  }
  if (!request.body) throw new HttpError(400, "Enviá una agenda en formato JSON.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new HttpError(413, "La agenda supera el límite de 1 MiB.");
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(""));
  } catch (error) {
    reader.cancel().catch(() => {});
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "No se pudo leer la agenda. Enviá JSON válido en UTF-8.");
  } finally {
    reader.releaseLock();
  }
}

function validateSnapshot(snapshot) {
  const keys = ["version", "language", "revision", "events"];
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
      Object.keys(snapshot).length !== keys.length || !keys.every(key => Object.hasOwn(snapshot, key)) ||
      snapshot.version !== 1 || snapshot.language !== "es" ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new HttpError(400, "La agenda debe incluir versión 1, idioma «es», una revisión entera no negativa y sus planes.");
  }
  try {
    Trip.validateEvents(snapshot.events);
  } catch (error) {
    throw new HttpError(400, error.message);
  }
  const events = JSON.stringify(snapshot.events);
  if (encoder.encode(events).byteLength > MAX_BYTES) {
    throw new HttpError(413, "La agenda supera el límite de 1 MiB.");
  }
  return events;
}

function database(env) {
  if (!env.DB || typeof env.DB.prepare !== "function") throw new Error("Missing database binding");
  return env.DB;
}

async function readAgenda(db) {
  let row = await db.prepare(READ_AGENDA).first();
  if (!row) {
    const initialized = await db.prepare(
      "INSERT INTO agenda (id, revision, events) VALUES (1, 0, ?) ON CONFLICT(id) DO NOTHING"
    ).bind(JSON.stringify(Trip.validateEvents(Trip.SEED))).run();
    if (initialized?.success !== true) throw new Error("Database initialization failed");
    row = await db.prepare(READ_AGENDA).first();
  }
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new Error("Invalid stored agenda");
  }
  return {
    version: 1,
    language: "es",
    revision: row.revision,
    events: Trip.validateEvents(JSON.parse(row.events))
  };
}

function preflight(request, headers) {
  const method = request.headers.get("Access-Control-Request-Method");
  if (method && !["GET", "PUT", "OPTIONS"].includes(method)) {
    headers.set("Allow", METHODS);
    throw new HttpError(405, "Usá GET, PUT u OPTIONS para la agenda.");
  }
  const requestedHeaders = request.headers.get("Access-Control-Request-Headers");
  if (requestedHeaders && requestedHeaders.split(",").some(header => !ALLOWED_HEADERS.has(header.trim().toLowerCase()))) {
    throw new HttpError(403, "La solicitud incluye cabeceras no permitidas.");
  }
  headers.set("Access-Control-Allow-Methods", METHODS);
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Family-Passphrase");
  return new Response(null, { status: 204, headers });
}

export default {
  async fetch(request, env = {}) {
    const origin = request.headers.get("Origin");
    const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" });
    if (ALLOWED_ORIGINS.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
    try {
      if (origin !== null && !ALLOWED_ORIGINS.has(origin)) {
        throw new HttpError(403, "Este origen no tiene permiso para acceder a la agenda.");
      }
      if (new URL(request.url).pathname !== "/api/agenda") {
        throw new HttpError(404, "La ruta solicitada no existe.");
      }
      if (!["GET", "PUT", "OPTIONS"].includes(request.method)) {
        headers.set("Allow", METHODS);
        throw new HttpError(405, "Usá GET, PUT u OPTIONS para la agenda.");
      }
      if (request.method === "OPTIONS") return preflight(request, headers);
      if (request.method === "GET") return json(await readAgenda(database(env)), 200, headers);

      const snapshot = await readJson(request);
      const events = validateSnapshot(snapshot);
      const db = database(env);
      await readAgenda(db);
      // The revision predicate and increment must stay in the same SQL statement.
      const saved = await db.prepare(
        `UPDATE agenda SET events = ?, revision = revision + 1
         WHERE id = 1 AND revision = ? AND revision < 9007199254740991`
      ).bind(events, snapshot.revision).run();
      if (saved?.success !== true) throw new Error("Database update failed");
      if (saved.meta?.changes === 1) {
        return json({ version: 1, language: "es", revision: snapshot.revision + 1, events: snapshot.events }, 200, headers);
      }
      if (saved.meta?.changes !== 0) throw new Error("Invalid database update result");
      const current = await readAgenda(db);
      if (current.revision === snapshot.revision) throw new Error("Agenda revision exhausted");
      return json({
        error: "Otra persona actualizó la agenda. Revisá la versión compartida antes de guardar de nuevo.",
        current
      }, 409, headers);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 503;
      if (status >= 500) console.error("[iberia-trip-agenda] Servicio de agenda no disponible.");
      return json({
        error: error instanceof HttpError ? error.message : "La agenda compartida no está disponible. Intentá de nuevo más tarde."
      }, status, headers);
    }
  }
};
