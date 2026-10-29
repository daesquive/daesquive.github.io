(function () {
  "use strict";
  const { STOPS, STATUS_LABELS, eventsOn, localInstant, buildICS } = Trip;
  const $ = id => document.getElementById(id);
  const form = $("event-form");
  let selectedDate = "2026-11-04";
  let activeStop = "madrid";
  let leafletMap = null;
  let mapLoading = false;
  let markers = [];
  let events = [];
  let editorBase = null;
  let importDraft = null;
  let eventSignature = "";
  let lastSaving = false;
  const dismissed = new Set();
  const clone = value => JSON.parse(JSON.stringify(value));
  const sync = TripSync.createClient({ url: globalThis.TRIP_SYNC_URL });
  const scrollBehavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
  const text = (tag, value, className) => {
    const el = document.createElement(tag);
    el.textContent = value;
    if (className) el.className = className;
    return el;
  };
  function feedback(message) { $("feedback").textContent = message; }
  function applySyncState(state) {
    $("sync-status").textContent = state.message;
    $("sync-status").dataset.state = state.status;
    $("retry-sync").disabled = state.saving || state.refreshing;
    $("storage-warning").hidden = !state.backupWarning;
    $("storage-warning").textContent = state.backupWarning;
    const legacy = state.legacy;
    $("legacy-notice").hidden = !legacy.available || (!legacy.hasChanges && !legacy.error);
    $("legacy-message").textContent = legacy.error || (legacy.migrated
      ? "Los planes anteriores de este navegador ya se compartieron. El original sigue intacto y podés descargarlo."
      : "Encontramos cambios anteriores guardados solo en este navegador. No se enviaron automáticamente. Compartilos para combinarlos con el calendario familiar; si un mismo plan cambió en ambos lados, se avisará sin sobrescribirlo.");
    $("share-legacy").hidden = !legacy.valid || !legacy.hasChanges || legacy.migrated;
    $("share-legacy").disabled = state.saving || legacy.checking;
    for (const id of ["add-event", "add-day", "import-json"]) $(id).disabled = state.saving;
    for (const currentForm of [form, $("import-form")]) {
      currentForm.setAttribute("aria-busy", String(state.saving));
      for (const field of currentForm.querySelectorAll("input, select, textarea, button")) field.disabled = state.saving;
    }
    const nextSignature = JSON.stringify(state.snapshot?.events || []);
    events = state.snapshot?.events || [];
    if (nextSignature !== eventSignature) {
      eventSignature = nextSignature;
      render();
    } else if (lastSaving !== state.saving) renderDay();
    lastSaving = state.saving;
  }
  const zoneLabel = zone => ({ "Europe/Madrid": "España", "Europe/Lisbon": "Portugal", "Europe/Gibraltar": "Gibraltar", "America/Costa_Rica": "Costa Rica" })[zone];
  const dateLabel = date => new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00Z`));
  function timing(e) {
    let label = e.time || (e.type === "stay" ? "Noche de alojamiento" : "Hora flexible");
    if (e.endTime) label += ` - ${e.endTime}`;
    if (e.endDate !== e.date) label += ` · ${e.date.slice(8)}-${e.endDate.slice(8)} nov. inclusive`;
    return `${label} · hora local de ${zoneLabel(e.zone)}`;
  }
  function openEditor(event = null, date = selectedDate) {
    if (sync.getState().saving) return;
    editorBase = sync.getSnapshot();
    if (!editorBase) {
      feedback("Primero cargá una versión válida del calendario compartido. Si no hay internet, solo se puede consultar una copia ya guardada.");
      return;
    }
    if (event) {
      event = editorBase.events.find(plan => plan.id === event.id);
      if (!event) { feedback("Este plan ya no está en el calendario actualizado."); return; }
    }
    form.reset();
    $("form-error").textContent = "";
    $("editor-title").textContent = event ? "Editar este plan" : "Agregar un plan";
    $("delete-event").hidden = !event;
    const dayPlans = eventsOn(events, date);
    const homeDay = dayPlans.length && dayPlans.every(e => e.zone === "America/Costa_Rica");
    const defaults = {
      id: globalThis.crypto?.randomUUID?.() || `plan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title: "", date, endDate: date, time: "", endTime: "",
      zone: homeDay ? "America/Costa_Rica" : STOPS.find(s => s.id === activeStop)?.zone || "Europe/Madrid",
      type: "activity", status: "planned", stay: "", stop: homeDay ? "" : activeStop,
      location: "", url: "", notes: "", reminder: -1
    };
    for (const [key, value] of Object.entries(event || defaults)) {
      const field = form.elements.namedItem(key);
      if (field) field.value = value;
    }
    $("event-dialog").showModal();
  }
  function selectDay(date, syncRoute = true) {
    selectedDate = date;
    const stop = eventsOn(events, date).find(e => e.stop);
    if (syncRoute && stop) activeStop = stop.stop;
    render();
    if (matchMedia("(max-width: 600px)").matches) $("day-title").scrollIntoView({ block: "start", behavior: scrollBehavior });
  }
  function chip(event, date) {
    const button = text("button", "", "event-chip");
    button.dataset.type = event.type;
    const time = text("time", event.time ? `${event.time} ` : "");
    button.append(time, document.createTextNode(`${event.done ? "✓ " : ""}${event.title}`));
    button.title = `${event.title} · ${timing(event)} · ${STATUS_LABELS[event.status]}`;
    button.addEventListener("click", () => { selectDay(date); openEditor(event); });
    return button;
  }
  function renderCalendar() {
    const grid = $("calendar");
    grid.replaceChildren();
    // November 1, 2026 is Sunday in a Monday-first calendar.
    for (let i = 0; i < 42; i++) {
      const day = i - 5;
      const cell = text("div", "", "day");
      if (day < 1 || day > 30) {
        cell.classList.add("outside");
        cell.setAttribute("aria-hidden", "true");
      } else {
        const date = `2026-11-${String(day).padStart(2, "0")}`;
        if (day >= 3 && day <= 19) cell.classList.add("travel");
        if (date === selectedDate) cell.classList.add("selected");
        const plans = eventsOn(events, date);
        const number = text("button", day, "day-number");
        number.setAttribute("aria-label", `${dateLabel(date)}, ${plans.length} ${plans.length === 1 ? "plan" : "planes"}`);
        number.setAttribute("aria-pressed", String(date === selectedDate));
        if (day === 3 || day === 19) number.append(text("span", day === 3 ? "SALIDA" : "CASA"));
        number.addEventListener("click", () => selectDay(date));
        cell.append(number);
        for (const e of plans.slice(0, 3)) cell.append(chip(e, date));
        if (plans.length > 3) {
          const more = text("button", `+${plans.length - 3} más`, "more");
          more.addEventListener("click", () => { selectDay(date); $("day-title").scrollIntoView({ block: "nearest", behavior: scrollBehavior }); });
          cell.append(more);
        }
      }
      grid.append(cell);
    }
  }
  function renderDay() {
    $("day-title").textContent = dateLabel(selectedDate);
    const plans = eventsOn(events, selectedDate);
    $("day-subtitle").textContent = `${plans.length} ${plans.length === 1 ? "plan" : "planes"} · ${plans.filter(e => e.status === "pending").length} con detalles pendientes`;
    $("day-events").replaceChildren();
    if (!plans.length) $("day-events").append(text("p", "Un día por escribir. Agregá un recordatorio, una comida o una nueva aventura.", "empty"));
    for (const e of plans) {
      const card = text("article", "", `event-card${e.done ? " done" : ""}`);
      card.dataset.type = e.type;
      card.append(text("div", timing(e), "timing"), text("h3", e.title));
      card.append(text("span", STATUS_LABELS[e.status], `badge ${e.status}`));
      if (e.stay) card.append(text("span", e.stay === "rv" ? "Autocaravana / camping" : "Hotel / apartamento", "badge"));
      if (e.location) card.append(text("p", e.location));
      if (e.notes) card.append(text("p", e.notes));
      if (e.reminder >= 0) card.append(text("p", `Recordatorio: ${e.reminder === 0 ? "a la hora del plan" : `${e.reminder} minutos antes`}${e.time ? "" : " (09:00 locales para planes sin hora)"}`));
      const actions = text("div", "", "actions");
      const edit = text("button", "Editar");
      edit.addEventListener("click", () => openEditor(e));
      actions.append(edit);
      const done = text("label", "", "done-control");
      const check = document.createElement("input");
      check.type = "checkbox"; check.checked = e.done; check.disabled = sync.getState().saving;
      check.addEventListener("change", async () => {
        const base = sync.getSnapshot();
        const checked = check.checked;
        if (!base || sync.getState().saving) { renderDay(); return; }
        try {
          await sync.save(base, base.events.map(x => x.id === e.id ? { ...x, done: checked } : x));
          feedback("Estado confirmado en el calendario compartido.");
        } catch (error) { renderDay(); feedback(error.message); }
      });
      done.append(check, document.createTextNode("Hecho"));
      actions.append(done);
      if (e.location) {
        const link = text("a", "Ver lugar ↗", "text-link");
        link.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.location)}`;
        link.target = "_blank"; link.rel = "noopener noreferrer";
        actions.append(link);
      }
      card.append(actions);
      if (e.url) {
        const link = text("a", "Reserva / información ↗", "text-link");
        link.href = e.url; link.target = "_blank"; link.rel = "noopener noreferrer";
        card.append(link);
      }
      $("day-events").append(card);
    }
  }
  function renderAgenda() {
    $("agenda").replaceChildren();
    $("print-itinerary").replaceChildren();
    for (let day = 1; day <= 30; day++) {
      const date = `2026-11-${String(day).padStart(2, "0")}`;
      const plans = eventsOn(events, date);
      if (!plans.length) continue;
      const section = text("section", "", "agenda-day");
      const heading = text("h3", "");
      const button = text("button", dateLabel(date));
      button.addEventListener("click", () => selectDay(date));
      heading.append(button);
      section.append(heading);
      const print = text("section", "", "print-day");
      print.append(text("h2", dateLabel(date)));
      for (const e of plans) {
        section.append(chip(e, date));
        const row = text("div", "", "print-event");
        row.append(text("strong", `${timing(e)} · ${e.title}${e.done ? " [hecho]" : ""}`), text("p", `${STATUS_LABELS[e.status]}${e.location ? ` · ${e.location}` : ""}`));
        if (e.notes) row.append(text("p", e.notes));
        print.append(row);
      }
      $("agenda").append(section);
      $("print-itinerary").append(print);
    }
  }
  function renderRoute() {
    $("route-stops").replaceChildren();
    for (const [i, s] of STOPS.entries()) {
      const button = text("button", `${i + 1}. ${s.name}`, s.id === activeStop ? "active" : "");
      button.setAttribute("aria-pressed", String(s.id === activeStop));
      button.addEventListener("click", () => chooseStop(s));
      $("route-stops").append(button);
    }
    const stop = STOPS.find(s => s.id === activeStop) || STOPS[0];
    $("route-detail").textContent = stop.note;
    const index = STOPS.indexOf(stop);
    const previous = STOPS[Math.max(0, index - 1)];
    const url = new URL("https://www.google.com/maps/dir/");
    url.search = new URLSearchParams({ api: "1", origin: `${previous.lat},${previous.lon}`, destination: `${stop.lat},${stop.lon}`, travelmode: "driving" }).toString();
    if (index === 0) url.searchParams.set("origin", `${STOPS[STOPS.length - 1].lat},${STOPS[STOPS.length - 1].lon}`);
    $("directions").href = url.href;
    if (leafletMap) {
      markers.forEach((marker, i) => { if (STOPS[i].id === activeStop) marker.openPopup(); });
    }
  }
  function chooseStop(stop) {
    activeStop = stop.id;
    selectedDate = stop.date;
    render();
  }
  function renderReminders() {
    const now = Date.now();
    const due = events.filter(e => {
      if (e.done || e.reminder < 0 || dismissed.has(e.id)) return false;
      const start = localInstant(e.date, e.time, e.zone);
      return now >= start - e.reminder * 60000 && now < start + 3600000;
    });
    $("due-reminders").replaceChildren();
    if (!due.length) $("due-reminders").textContent = "No hay recordatorios para este momento.";
    for (const e of due) {
      const box = text("div", `${e.title} · ${timing(e)} `);
      const dismiss = text("button", "Descartar aviso");
      dismiss.addEventListener("click", () => { dismissed.add(e.id); renderReminders(); });
      box.append(dismiss);
      $("due-reminders").append(box);
    }
  }
  function render() { renderCalendar(); renderDay(); renderAgenda(); renderRoute(); renderReminders(); }
  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  for (const s of [{ id: "", name: "Sin parada / Costa Rica" }, ...STOPS]) {
    const option = text("option", s.name); option.value = s.id;
    form.elements.namedItem("stop").append(option);
  }
  $("add-event").addEventListener("click", () => openEditor());
  $("add-day").addEventListener("click", () => openEditor());
  $("close-dialog").addEventListener("click", () => $("event-dialog").close());
  for (const id of ["event-dialog", "import-dialog"]) {
    $(id).addEventListener("cancel", event => { if (sync.getState().saving) event.preventDefault(); });
  }
  form.elements.namedItem("date").addEventListener("change", event => {
    const end = form.elements.namedItem("endDate");
    if (end.value < event.target.value) end.value = event.target.value;
  });
  form.elements.namedItem("type").addEventListener("change", event => {
    if (event.target.value !== "stay") form.elements.namedItem("stay").value = "";
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!editorBase || sync.getState().saving) return;
    $("form-error").textContent = "";
    const fields = Object.fromEntries(new FormData(form));
    const old = editorBase.events.find(e => e.id === fields.id);
    const entry = { ...old, ...fields };
    entry.reminder = Number(entry.reminder);
    entry.title = entry.title.trim();
    entry.done = old?.done || false;
    const next = old ? editorBase.events.map(e => e.id === old.id ? entry : e) : [...editorBase.events, entry];
    try {
      await sync.save(editorBase, next);
      selectedDate = entry.date;
      if (entry.stop) activeStop = entry.stop;
      render();
      $("event-dialog").close();
      feedback("Plan confirmado en el calendario compartido. Los demás dispositivos se actualizan automáticamente.");
    } catch (error) { $("form-error").textContent = error.message; }
  });
  $("delete-event").addEventListener("click", async () => {
    if (!editorBase || sync.getState().saving) return;
    const id = form.elements.namedItem("id").value;
    const existing = editorBase.events.find(e => e.id === id);
    if (!existing || !confirm(`¿Eliminar «${existing.title}» del calendario compartido? Se quitará de todos los días que abarca y de todos los dispositivos.`)) return;
    $("form-error").textContent = "";
    try {
      await sync.save(editorBase, editorBase.events.filter(e => e.id !== id));
      $("event-dialog").close();
      feedback("Eliminación confirmada en el calendario compartido.");
    }
    catch (error) { $("form-error").textContent = error.message; }
  });
  $("view-toggle").addEventListener("click", () => {
    const agenda = $("agenda").hidden;
    $("agenda").hidden = !agenda;
    $("month-view").hidden = agenda;
    $("view-toggle").textContent = agenda ? "Ver mes" : "Ver agenda";
    $("view-toggle").setAttribute("aria-pressed", String(agenda));
  });
  $("export-json").addEventListener("click", () => {
    if (!sync.getSnapshot()) { feedback("Todavía no hay una copia válida del calendario para descargar."); return; }
    download("noviembre-iberico-copia.json", JSON.stringify({ version: 1, language: "es", events }, null, 2), "application/json");
    feedback("Copia descargada. Incluye el itinerario y las notas; mantenela privada.");
  });
  $("import-json").addEventListener("click", () => {
    if (!sync.getSnapshot()) { feedback("Cargá primero el calendario compartido antes de importar una copia."); return; }
    $("import-file").click();
  });
  $("import-file").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    const base = sync.getSnapshot();
    try {
      if (!base) throw new Error("No hay una versión válida del calendario con la que combinar esta copia.");
      if (file.size > 10 * 1024 * 1024) throw new Error("La copia es demasiado grande (máximo 10 MB).");
      const backup = JSON.parse(await file.text());
      const imported = TripSync.readBackup(backup);
      if (!confirm(`¿Usar los ${imported.length} planes de esta copia para reemplazar TODOS los ${base.events.length} planes que estás viendo, en todos los dispositivos? Guardá primero una copia actual si hace falta. Los cambios simultáneos se combinarán solo si no hay conflictos.`)) return;
      importDraft = { base: clone(base), events: imported };
      $("import-summary").textContent = `${file.name}: ${imported.length} planes. La importación solo se aplicará cuando el servidor confirme el guardado.`;
      $("import-error").textContent = "";
      $("import-dialog").showModal();
    } catch (error) { feedback(`No se pudo preparar la importación: ${error.message} No se enviaron cambios.`); }
    finally { event.target.value = ""; }
  });
  $("cancel-import").addEventListener("click", () => { $("import-dialog").close(); importDraft = null; });
  $("import-dialog").addEventListener("close", () => { if (!sync.getState().saving) importDraft = null; });
  $("import-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!importDraft || sync.getState().saving) return;
    $("import-error").textContent = "";
    try {
      await sync.save(importDraft.base, importDraft.events);
      $("import-dialog").close();
      importDraft = null;
      feedback("Importación confirmada en el calendario compartido; se conservaron los cambios simultáneos compatibles.");
    } catch (error) { $("import-error").textContent = `${error.message} La copia seleccionada se conserva para reintentar o descargarla desde su archivo original.`; }
  });
  $("share-legacy").addEventListener("click", async () => {
    $("legacy-error").textContent = "";
    try {
      const result = await sync.shareLegacy();
      feedback(result.skipped
        ? "Esta copia no tiene cambios pendientes de compartir. El original de este navegador sigue intacto."
        : "Planes anteriores confirmados en el calendario compartido. La copia original de este navegador no se modificó.");
    } catch (error) { $("legacy-error").textContent = error.message; }
  });
  $("download-legacy").addEventListener("click", () => {
    const original = sync.getLegacyOriginal();
    if (original === null) { feedback("No se encontró una copia anterior en este navegador."); return; }
    download("noviembre-iberico-original-de-este-navegador.json", original, "application/json");
    feedback("Original descargado sin modificar, aunque contenga errores. Mantenelo privado.");
  });
  $("export-ics").addEventListener("click", () => {
    try {
      if (!sync.getSnapshot()) throw new Error("Todavía no hay una copia válida del calendario.");
      download("noviembre-iberico-2026.ics", buildICS(events), "text/calendar;charset=utf-8");
      feedback("Calendario exportado sin los planes completados. Importalo en el teléfono y revisá sus alertas. Importarlo de nuevo puede crear duplicados; no es una sincronización automática.");
    } catch (error) { feedback(`No se pudo exportar el calendario: ${error.message}`); }
  });
  $("print").addEventListener("click", () => window.print());
  function mapFeedback(message, error = false) {
    $("map-status").textContent = message;
    $("map-status").classList.toggle("error", error);
  }
  async function loadOnlineMap() {
    if (leafletMap || mapLoading) return;
    mapLoading = true;
    mapFeedback("Cargando el mapa en línea…");
    try {
      const styleReady = new Promise((resolve, reject) => {
        if ($("leaflet-css")?.sheet) { resolve(); return; }
        $("leaflet-css")?.remove();
        const css = document.createElement("link");
        css.id = "leaflet-css"; css.rel = "stylesheet";
        css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        const timer = setTimeout(() => { css.remove(); reject(new Error("Se agotó el tiempo de carga de los estilos del mapa.")); }, 15000);
        css.onload = () => { clearTimeout(timer); resolve(); };
        css.onerror = () => { clearTimeout(timer); css.remove(); reject(new Error("No se pudieron cargar los estilos del mapa.")); };
        document.head.append(css);
      });
      const scriptReady = window.L ? Promise.resolve() : new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
        const timer = setTimeout(() => { script.remove(); reject(new Error("Se agotó el tiempo de descarga del mapa.")); }, 15000);
        script.onload = () => { clearTimeout(timer); resolve(); };
        script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error("No se pudo cargar la biblioteca del mapa.")); };
        document.head.append(script);
      });
      await Promise.all([styleReady, scriptReady]);
      $("street-map").hidden = false;
      leafletMap = L.map("street-map", { zoomControl: false }).setView([38.7, -6.2], 6);
      L.control.zoom({ zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(leafletMap);
      const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18, referrerPolicy: "strict-origin-when-cross-origin",
        attribution: '&copy; Colaboradores de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      });
      let tileErrorShown = false;
      tiles.on("loading", () => {
        tileErrorShown = false;
        mapFeedback("Cargando las imágenes del mapa...");
      });
      tiles.on("tileerror", () => {
        if (!tileErrorShown) mapFeedback("No se pudieron cargar algunas imágenes del mapa (posible bloqueo del proveedor). Revisá la conexión; los enlaces de indicaciones siguen disponibles.", true);
        tileErrorShown = true;
      });
      tiles.on("load", () => {
        if (!tileErrorShown) mapFeedback("Mapa cargado. Las líneas son esquemáticas, no rutas calculadas por carretera.");
      });
      const coordinates = [...STOPS, STOPS[0]].map(s => [s.lat, s.lon]);
      L.polyline(coordinates, { color: "#b76b3d", dashArray: "5 5" }).addTo(leafletMap);
      markers = STOPS.map(s => {
        const marker = L.circleMarker([s.lat, s.lon], { radius: 7, color: "#193f3c", fillOpacity: 1 }).addTo(leafletMap);
        marker.bindPopup(text("span", `${s.name} (centro aproximado de la ciudad)`));
        marker.on("click", () => chooseStop(s));
        return marker;
      });
      leafletMap.fitBounds(coordinates, { padding: [20, 20] });
      tiles.addTo(leafletMap);
    } catch (error) {
      if (leafletMap) { leafletMap.remove(); leafletMap = null; markers = []; }
      $("street-map").hidden = true;
      mapFeedback(`${error.message} Revisá la conexión y recargá la página para reintentar. El calendario y los enlaces de indicaciones siguen disponibles.`, true);
    } finally { mapLoading = false; }
  }
  function refreshShared(force = false) {
    if (!force && document.visibilityState === "hidden") return;
    if (navigator.onLine === false) { sync.markOffline(); return; }
    return sync.refresh({ force }).catch(() => {});
  }
  $("retry-sync").addEventListener("click", () => refreshShared(true));
  window.addEventListener("focus", () => refreshShared());
  window.addEventListener("online", () => {
    refreshShared();
    if (leafletMap) leafletMap.eachLayer(layer => { if (layer instanceof L.TileLayer) layer.redraw(); });
    else loadOnlineMap();
  });
  window.addEventListener("offline", () => sync.markOffline());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshShared(); });
  window.addEventListener("storage", event => {
    if ([TripSync.LEGACY_KEY, TripSync.CACHE_KEY, TripSync.MIGRATION_KEY, null].includes(event.key)) {
      sync.checkLegacy();
      refreshShared();
    }
  });
  globalThis.tripAgendaSync = Object.freeze({
    getState: () => sync.getState(),
    getSnapshot: () => sync.getSnapshot(),
    refresh: () => sync.refresh({ force: true })
  });
  render();
  sync.subscribe(applySyncState);
  refreshShared(true);
  loadOnlineMap();
  if (matchMedia("(max-width: 600px)").matches) $("view-toggle").click();
  setInterval(refreshShared, 10000);
  setInterval(renderReminders, 30000);
})();
