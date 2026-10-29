(function () {
  "use strict";
  const { SEED, STOPS, STATUS_LABELS, migrateSpanish, validateEvents, eventsOn, localInstant, buildICS } = Trip;
  const KEY = "atlas-iberia-november-2026-v1";
  const $ = id => document.getElementById(id);
  const form = $("event-form");
  let selectedDate = "2026-11-04";
  let activeStop = "madrid";
  let leafletMap = null;
  let markers = [];
  let events;
  let storedSnapshot = null;
  let corruptStorage = false;
  let storageBlockMessage = "No se pudieron cargar los datos guardados. Importá una copia válida antes de guardar cambios; no se sobrescribirá el original automáticamente.";
  const dismissed = new Set();
  const clone = value => JSON.parse(JSON.stringify(value));
  const scrollBehavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
  const text = (tag, value, className) => {
    const el = document.createElement(tag);
    el.textContent = value;
    if (className) el.className = className;
    return el;
  };
  function feedback(message) { $("feedback").textContent = message; }
  function warning(message) {
    $("storage-warning").hidden = false;
    $("storage-warning").textContent = message;
  }
  const serialize = plans => JSON.stringify({ version: 1, language: "es", events: plans });
  function readBackup(backup) {
    if (!backup || backup.version !== 1) throw new Error("La versión de la copia no es compatible.");
    const plans = validateEvents(backup.events);
    return backup.language === "es" ? plans : migrateSpanish(plans);
  }
  try {
    const saved = localStorage.getItem(KEY);
    if (saved !== null) {
      const backup = JSON.parse(saved);
      events = readBackup(backup);
      storedSnapshot = saved;
      if (backup.language !== "es") {
        const translated = serialize(events);
        localStorage.setItem(KEY, translated);
        storedSnapshot = translated;
      }
    } else {
      events = clone(SEED);
      storedSnapshot = serialize(events);
      localStorage.setItem(KEY, storedSnapshot);
    }
  } catch (error) {
    events = clone(SEED);
    corruptStorage = true;
    warning(`No se pudieron cargar los planes: ${error.message} NO se sobrescribieron los datos guardados. Se muestra el itinerario inicial. Importá una copia válida o guardá estos planes como copia de seguridad.`);
  }
  function commit(next, replaceDamaged = false) {
    validateEvents(next);
    if (corruptStorage && !replaceDamaged) throw new Error(storageBlockMessage);
    if (!replaceDamaged) {
      const current = localStorage.getItem(KEY);
      if (current !== storedSnapshot) {
        corruptStorage = true;
        storageBlockMessage = "Otra pestaña cambió el itinerario guardado. Guardá una copia de tu trabajo y recargá antes de editar, o importá una copia para reemplazarlo.";
        warning(storageBlockMessage);
        throw new Error(storageBlockMessage);
      }
    }
    const serialized = serialize(next);
    try { localStorage.setItem(KEY, serialized); }
    catch (error) {
      warning(`No se pudo guardar: ${error.message} El cambio no se aplicó. Guardá una copia y revisá los permisos o el espacio del navegador.`);
      throw new Error("No se pudo guardar el cambio en este navegador.");
    }
    events = next;
    storedSnapshot = serialized;
    corruptStorage = false;
    $("storage-warning").hidden = true;
    render();
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
    form.reset();
    $("form-error").textContent = "";
    $("editor-title").textContent = event ? "Editar este plan" : "Agregar un plan";
    $("delete-event").hidden = !event;
    const dayPlans = eventsOn(events, date);
    const homeDay = dayPlans.length && dayPlans.every(e => e.zone === "America/Costa_Rica");
    const defaults = {
      id: "", title: "", date, endDate: date, time: "", endTime: "",
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
      check.type = "checkbox"; check.checked = e.done;
      check.addEventListener("change", () => {
        try { commit(events.map(x => x.id === e.id ? { ...x, done: check.checked } : x)); }
        catch (error) { check.checked = e.done; feedback(error.message); }
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
    const ns = "http://www.w3.org/2000/svg";
    const svgNode = (tag, attrs = {}) => {
      const el = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      return el;
    };
    const point = s => [Math.round((s.lon + 10) * 78), Math.round((41.5 - s.lat) * 52)];
    const svg = svgNode("svg", { viewBox: "0 0 650 350", role: "group", "aria-label": "Ruta esquemática entre ciudades, no es un mapa de carreteras" });
    const sea = svgNode("path", { d: "M0 0H120L103 65 84 100 59 145 79 175 60 214 98 252 146 248 190 288 280 322 650 322V350H0Z", class: "water" });
    svg.append(sea);
    const caption = svgNode("text", { x: 15, y: 310 });
    caption.textContent = "ATLÁNTICO"; svg.append(caption);
    const route = [...STOPS, STOPS[0]].map(point).map(p => p.join(",")).join(" ");
    svg.append(svgNode("polyline", { points: route, fill: "none", stroke: "#b76b3d", "stroke-width": 2, "stroke-dasharray": "5 4" }));
    const offsets = { madrid: [12, -14], alcala: [12, 0], toledo: [10, 21], granada: [10, -8], malaga: [10, 22], gibraltar: [-112, 14] };
    STOPS.forEach((s, i) => {
      const [x, y] = point(s);
      const g = svgNode("g", { class: `city${activeStop === s.id ? " active" : ""}`, tabindex: 0, role: "button", "aria-label": `${i + 1}. ${s.name}, ver itinerario`, "aria-pressed": String(activeStop === s.id) });
      const title = svgNode("title"); title.textContent = s.name;
      const dot = svgNode("circle", { cx: x, cy: y, r: 10 });
      const num = svgNode("text", { x, y: y + 4, "text-anchor": "middle" }); num.textContent = i + 1;
      const [dx, dy] = offsets[s.id] || [14, 3];
      const label = svgNode("text", { x: x + dx, y: y + dy }); label.textContent = s.name;
      g.append(title, dot, num, label);
      g.addEventListener("click", () => chooseStop(s));
      g.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); chooseStop(s); } });
      svg.append(g);
    });
    $("route-map").replaceChildren(svg);
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
  form.elements.namedItem("date").addEventListener("change", event => {
    const end = form.elements.namedItem("endDate");
    if (end.value < event.target.value) end.value = event.target.value;
  });
  form.elements.namedItem("type").addEventListener("change", event => {
    if (event.target.value !== "stay") form.elements.namedItem("stay").value = "";
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const entry = Object.fromEntries(new FormData(form));
    entry.reminder = Number(entry.reminder);
    const old = events.find(e => e.id === entry.id);
    entry.id ||= globalThis.crypto?.randomUUID?.() || `plan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    entry.title = entry.title.trim();
    entry.done = old?.done || false;
    const next = old ? events.map(e => e.id === old.id ? entry : e) : [...events, entry];
    try {
      commit(next);
      selectedDate = entry.date;
      if (entry.stop) activeStop = entry.stop;
      render();
      $("event-dialog").close();
      feedback("Plan guardado en este navegador. Exportá una copia de seguridad para conservarlo aparte.");
    } catch (error) { $("form-error").textContent = error.message; }
  });
  $("delete-event").addEventListener("click", () => {
    const id = form.elements.namedItem("id").value;
    const existing = events.find(e => e.id === id);
    if (!existing || !confirm(`¿Eliminar «${existing.title}»? Se quitará de todos los días que abarca.`)) return;
    try { commit(events.filter(e => e.id !== id)); $("event-dialog").close(); feedback("Plan eliminado."); }
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
    download("noviembre-iberico-copia.json", JSON.stringify({ version: 1, language: "es", events }, null, 2), "application/json");
    feedback("Copia descargada. Incluye el itinerario y las notas; mantenela privada.");
  });
  $("import-json").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("La copia es demasiado grande (máximo 10 MB).");
      const backup = JSON.parse(await file.text());
      const imported = readBackup(backup);
      if (!confirm(`¿Reemplazar TODOS los planes actuales por los ${imported.length} planes de esta copia? Guardá primero una copia de los planes actuales si hace falta.`)) return;
      commit(imported, true);
      feedback("Copia importada y guardada. Se reemplazaron los planes anteriores.");
    } catch (error) { feedback(`No se pudo importar: ${error.message} Los planes actuales no se reemplazaron.`); }
    finally { event.target.value = ""; }
  });
  $("export-ics").addEventListener("click", () => {
    try {
      download("noviembre-iberico-2026.ics", buildICS(events), "text/calendar;charset=utf-8");
      feedback("Calendario exportado sin los planes completados. Importalo en el teléfono y revisá sus alertas. Importarlo de nuevo puede crear duplicados; no es una sincronización automática.");
    } catch (error) { feedback(`No se pudo exportar el calendario: ${error.message}`); }
  });
  $("print").addEventListener("click", () => window.print());
  $("toggle-map").addEventListener("click", async () => {
    const button = $("toggle-map");
    if (leafletMap) {
      $("street-map").hidden = !$("street-map").hidden;
      button.textContent = $("street-map").hidden ? "Mostrar mapa en línea" : "Ocultar mapa en línea";
      if (!$("street-map").hidden) leafletMap.invalidateSize();
      return;
    }
    button.disabled = true; button.textContent = "Cargando mapa...";
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
        maxZoom: 18, attribution: '&copy; Colaboradores de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }).addTo(leafletMap);
      let tileErrorShown = false;
      tiles.on("tileerror", () => {
        if (!tileErrorShown) feedback("No se pudieron cargar algunas partes del mapa. El esquema sin conexión y el itinerario siguen disponibles.");
        tileErrorShown = true;
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
      button.textContent = "Ocultar mapa en línea";
      feedback("Mapa cargado. Las líneas son esquemáticas, no rutas calculadas por carretera.");
    } catch (error) {
      if (leafletMap) { leafletMap.remove(); leafletMap = null; markers = []; }
      $("street-map").hidden = true;
      button.textContent = "Reintentar mapa en línea";
      feedback(`${error.message} El mapa sin conexión y el calendario siguen funcionando.`);
    } finally { button.disabled = false; }
  });
  window.addEventListener("storage", event => {
    if (event.key === KEY || event.key === null) {
      corruptStorage = true;
      storageBlockMessage = "El calendario cambió en otra pestaña. Guardá una copia de tu trabajo y recargá esta página antes de editar para no sobrescribir esos cambios.";
      warning(storageBlockMessage);
    }
  });
  render();
  if (matchMedia("(max-width: 600px)").matches) $("view-toggle").click();
  setInterval(renderReminders, 30000);
})();
