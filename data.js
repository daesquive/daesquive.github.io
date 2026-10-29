(function (root) {
  "use strict";
  const ZONES = ["Europe/Madrid", "Europe/Lisbon", "Europe/Gibraltar", "America/Costa_Rica"];
  const TYPES = ["activity", "drive", "stay", "meal", "flight", "reminder"];
  const STATUSES = ["planned", "reserved", "pending"];
  const REMINDERS = [-1, 0, 30, 60, 120, 1440];
  const STATUS_LABELS = { planned: "Planeado", reserved: "Reservado", pending: "Detalles pendientes" };
  const STOPS = [
    { id: "madrid", name: "Madrid", lat: 40.4168, lon: -3.7038, date: "2026-11-04", zone: ZONES[0], note: "Llegada el 4 de noviembre; regreso el 14 para la estancia final." },
    { id: "caceres", name: "Cáceres", lat: 39.4753, lon: -6.3724, date: "2026-11-05", zone: ZONES[0], note: "Almuerzo y paseo por el casco antiguo; salir a más tardar a las 16:00." },
    { id: "lisbon", name: "Lisboa", lat: 38.7223, lon: -9.1393, date: "2026-11-05", zone: ZONES[1], note: "Del 5 al 8 de noviembre: Lisboa Camping, tuk-tuks, Time Out Market y compras." },
    { id: "seville", name: "Sevilla", lat: 37.3891, lon: -5.9845, date: "2026-11-08", zone: ZONES[0], note: "Del 8 al 10 de noviembre: Área Autocaravanas Sevilla y recorrido en scooters." },
    { id: "gibraltar", name: "Gibraltar / La Línea", lat: 36.1512, lon: -5.3548, date: "2026-11-10", zone: ZONES[2], note: "Del 10 al 12 de noviembre: estacionar en Alcaidesa Marina, España, y visitar Gibraltar. Confirmar acceso fronterizo y estacionamiento." },
    { id: "malaga", name: "Málaga", lat: 36.7213, lon: -4.4214, date: "2026-11-12", zone: ZONES[0], note: "Parada para almorzar camino a Granada; no está previsto pasar la noche." },
    { id: "granada", name: "Granada", lat: 37.1773, lon: -3.5986, date: "2026-11-12", zone: ZONES[0], note: "Del 12 al 14 de noviembre: descanso, tren eléctrico y Alhambra. Pendientes el alojamiento y la hora de entrada." },
    { id: "toledo", name: "Toledo", lat: 39.8628, lon: -4.0273, date: "2026-11-14", zone: ZONES[0], note: "Almuerzo antes de las entregas de vehículos en Madrid." },
    { id: "alcala", name: "Alcalá de Henares", lat: 40.4818, lon: -3.3641, date: "2026-11-14", zone: ZONES[0], note: "Retiro/devolución de autocaravana: C. Brasil, 9C, 28806 Alcalá de Henares. El punto representa el centro, no el local de alquiler. Devolver antes de las 16:00." }
  ];
  const base = (day, title, type = "activity", time = "", options = {}) => ({
    id: `seed-${String(day).padStart(2, "0")}-${++sequence}`,
    date: `2026-11-${String(day).padStart(2, "0")}`,
    endDate: `2026-11-${String(day).padStart(2, "0")}`,
    title, type, time, endTime: "", zone: ZONES[0], status: "planned",
    stay: "", stop: "madrid", location: "", url: "", notes: "", reminder: -1, done: false,
    ...options
  });
  let sequence = 0;
  // Keep the original text solely to migrate untouched fields in existing backups.
  const LEGACY_SEED = [
    base(3, "Reserved airport taxi pickup", "drive", "13:00", { zone: ZONES[3], stop: "", status: "reserved", location: "Home to SJO airport", notes: "Pickup at 13:00; be at SJO no later than 14:00." }),
    base(3, "Be at SJO airport by 14:00", "reminder", "14:00", { zone: ZONES[3], stop: "", location: "Juan Santamaria International Airport (SJO)" }),
    base(3, "Iberia IB0244 departs SJO", "flight", "17:25", { zone: ZONES[3], stop: "", location: "SJO airport", notes: "Overnight flight to Madrid. Arrival: November 4, 10:15 Madrid local time. Arrival is a separate calendar event." }),
    base(4, "Land in Madrid - Iberia IB0244", "flight", "10:15", { location: "Madrid-Barajas Airport (MAD)", notes: "Corrected arrival time: 10:15, not the earlier 10:35. Allow for immigration, baggage and hotel transfer." }),
    base(4, "AC Madrid Airport Hotel - settle in", "stay", "", { stay: "hotel", location: "AC Madrid Airport Hotel", notes: "Night of November 4; checkout November 5. Confirm exact property/address and early check-in availability." }),
    base(4, "Light lunch at the hotel", "meal", "", { location: "AC Madrid Airport Hotel", notes: "Time flexible after arrival." }),
    base(4, "Pick up the motorhome", "drive", "", { stop: "alcala", status: "pending", location: "C. Brasil, 9C, 28806 Alcala de Henares, Madrid, Spain", notes: "Pickup time and transfer to the depot pending. Confirm handover, Portugal permission and overnight parking while staying at the hotel." }),
    base(4, "Dinner - Asador 7 de Julio", "meal", "19:00", { status: "reserved", location: "Asador 7 de Julio", notes: "Dinner reservation; exact restaurant address pending." }),
    base(5, "Leave Madrid in the RV", "drive", "07:30", { stop: "caceres", location: "Madrid to Caceres", notes: "Target arrival around noon. Allow fuel, rest and parking stops; timing is a plan, not a live ETA." }),
    base(5, "Caceres lunch and old town walk", "activity", "12:00", { stop: "caceres", endTime: "16:00", location: "Caceres old town", notes: "Lunch followed by a walking tour. Leave no later than 16:00 Spain time." }),
    base(5, "Leave Caceres for Lisbon", "drive", "16:00", { stop: "lisbon", zone: ZONES[0], location: "Caceres to Lisboa Camping", notes: "Departure deadline uses Spain time. Arrival target is 19:00-20:00 PORTUGAL time, one hour behind Spain. Check route, tolls and campsite late-arrival procedures." }),
    base(5, "Arrive at Lisboa Camping", "drive", "19:00", { stop: "lisbon", zone: ZONES[1], location: "Lisboa Camping RV park", notes: "Approximate arrival window: 19:00-20:00 Lisbon local time." }),
    base(5, "Lisboa Camping - RV nights", "stay", "", { endDate: "2026-11-07", stay: "rv", stop: "lisbon", zone: ZONES[1], location: "Lisboa Camping", notes: "Nights November 5, 6 and 7; depart November 8. Reservation status and exact pitch pending." }),
    base(6, "Lisbon tuk-tuk city tour", "activity", "09:00", { stop: "lisbon", zone: ZONES[1], notes: "Meeting point, duration and booking details pending." }),
    base(6, "Lunch - Time Out Market Lisboa", "meal", "12:00", { stop: "lisbon", zone: ZONES[1], location: "Time Out Market Lisboa", notes: "Venue name confirmed. Lunch plan, not a confirmed table reservation." }),
    base(6, "Explore Lisbon - flexible afternoon", "activity", "", { stop: "lisbon", zone: ZONES[1], notes: "Choose attractions on the way; leave room for breaks." }),
    base(7, "Lisbon outlet shopping", "activity", "", { stop: "lisbon", zone: ZONES[1], notes: "Outlets and route to be chosen. Allow travel to Rio de Mouro for dinner." }),
    base(7, "Dinner - Plataforma (Harry Potter themed)", "meal", "19:00", { stop: "lisbon", zone: ZONES[1], status: "reserved", location: "Largo Joaquim Jose Correia, Rio de Mouro 2635, Portugal", notes: "Restaurant: Plataforma. Rio de Mouro is outside central Lisbon; plan the transfer." }),
    base(8, "Leave Lisbon for Seville", "drive", "08:00", { stop: "seville", zone: ZONES[1], location: "Lisboa Camping to Seville", notes: "Departure in Portugal time; Seville arrival target 15:00 Spain time. Spain is one hour ahead. Lunch at a suitable restaurant en route." }),
    base(8, "Lunch on the road to Seville", "meal", "", { stop: "seville", notes: "Restaurant and time flexible; check RV parking." }),
    base(8, "Arrive in Seville and explore", "activity", "15:00", { stop: "seville", notes: "Approximate arrival; a short city visit if energy allows." }),
    base(8, "Area Autocaravanas Sevilla - RV nights", "stay", "", { endDate: "2026-11-09", stop: "seville", stay: "rv", location: "Area Autocaravanas Sevilla", notes: "Nights November 8 and 9; depart November 10. Reservation status pending." }),
    base(9, "Booked Seville scooter tour", "activity", "10:00", { stop: "seville", status: "reserved", notes: "Approximate start time. Confirm meeting point, duration and participation requirements." }),
    base(9, "Lunch in Seville", "meal", "12:00", { stop: "seville" }),
    base(9, "Rest - free afternoon", "activity", "", { stop: "seville" }),
    base(10, "Leave Seville for Gibraltar / La Linea", "drive", "09:00", { stop: "gibraltar", location: "Seville to Alcaidesa Marina" }),
    base(10, "Alcaidesa Marina - RV nights", "stay", "", { endDate: "2026-11-11", stay: "rv", stop: "gibraltar", location: "Area de Autocaravanas Alcaidesa Marina", notes: "Nights November 10 and 11; depart November 12. Located on the Spanish side. Confirm space, border access and campsite booking." }),
    base(10, "Gibraltar Game Center - afternoon", "activity", "", { stop: "gibraltar", zone: ZONES[2], status: "pending", notes: "Exact Game Center venue and opening hours pending." }),
    base(11, "Tour Gibraltar", "activity", "", { stop: "gibraltar", zone: ZONES[2], notes: "Choose route and attractions; tour booking/meeting point not yet specified." }),
    base(12, "Leave for Malaga and Granada", "drive", "09:00", { stop: "malaga", location: "Alcaidesa Marina to Malaga, then Granada" }),
    base(12, "Lunch stop in Malaga", "meal", "", { stop: "malaga", notes: "Time and restaurant flexible. No Malaga overnight stay planned." }),
    base(12, "Arrive in Granada - rest afternoon", "activity", "15:00", { stop: "granada", notes: "Approximate arrival time." }),
    base(12, "Granada - overnight location pending", "stay", "", { endDate: "2026-11-13", stay: "rv", stop: "granada", status: "pending", notes: "Nights November 12 and 13. RV campsite assumed for planning only; change if choosing a hotel. No site or reservation supplied." }),
    base(13, "Booked all-day electric train pass", "activity", "", { stop: "granada", status: "reserved", notes: "Tour Granada. Operator and operating hours pending. This pass is NOT assumed to include Alhambra admission." }),
    base(13, "Visit Alhambra complex", "activity", "", { stop: "granada", status: "pending", location: "Alhambra, Granada", notes: "Confirm separately booked admission and any timed Nasrid Palaces entry. Plan train route around the admission slot." }),
    base(14, "Leave Granada", "drive", "08:00", { stop: "toledo", location: "Granada to Toledo, then Madrid", notes: "Busy transfer day; check driving time and whether Toledo lunch fits before the RV return deadline." }),
    base(14, "Lunch in Toledo", "meal", "", { stop: "toledo", notes: "Time/restaurant flexible. Shorten stop if needed to protect the RV handover." }),
    base(14, "Madrid-area arrival target", "drive", "14:00", { location: "Madrid area", notes: "Target 14:00-15:00; not a guaranteed ETA. RV depot is in Alcala de Henares, not central Madrid." }),
    base(14, "Return RV BEFORE 16:00", "drive", "16:00", { stop: "alcala", location: "C. Brasil, 9C, 28806 Alcala de Henares, Madrid, Spain", notes: "16:00 is the deadline, NOT the arrival appointment. Arrive earlier for inspection/handover. Actual return slot and transfer to Avis pending." }),
    base(14, "Pick up Avis rental car - Barajas T1", "drive", "", { location: "Avis, Terminal 1, Madrid-Barajas Airport", status: "pending", notes: "After RV return. Pickup appointment and transfer from Alcala de Henares pending." }),
    base(14, "Check in - Libere Madrid Palacio Real", "activity", "", { location: "Libere Madrid Palacio Real apartments", notes: "After car pickup. Confirm check-in instructions and parking." }),
    base(14, "Libere Madrid Palacio Real - apartment nights", "stay", "", { endDate: "2026-11-18", stay: "hotel", location: "Libere Madrid Palacio Real apartments", notes: "Nights November 14-18; checkout November 19. Booking status not specified." }),
    base(14, "Dinner - Le Petit Chef", "meal", "21:00", { status: "reserved", location: "Le Petit Chef, Madrid", notes: "Exact venue/address pending. Allow time after vehicle handovers and apartment check-in." }),
    base(15, "Madrid hop-on / hop-off sightseeing bus", "activity", "", { notes: "Double-decker bus with attraction stops. Operator, tickets and route pending." }),
    base(16, "Madrid shopping day", "activity", "", { notes: "Choose stores and shopping areas on the way." }),
    base(17, "Explore Madrid attractions", "activity", "", { notes: "Flexible sightseeing; leave time for dinner." }),
    base(17, "Dinner - The Roof Top 360", "meal", "20:00", { status: "reserved", location: "The Roof Top 360, Madrid", notes: "Venue/address to verify. 20:00 is after sunset in November; arrange an earlier visit separately if sunset views are important." }),
    base(18, "Rest, pack and prepare for departure", "reminder", "", { notes: "Pack bags; check flight/terminal and rental return instructions; plan morning checkout and airport drive. Do not store passports or payment details here." }),
    base(19, "Return Avis car at MAD airport", "drive", "08:00", { location: "Madrid-Barajas Airport", notes: "Return location/terminal pending. Allow rental inspection, terminal transfer, check-in and security before 11:35 departure." }),
    base(19, "Flight departs Madrid", "flight", "11:35", { location: "Madrid-Barajas Airport (MAD)", notes: "Return flight number and departure terminal pending. Arrival SJO at 15:45 Costa Rica local time; separate event." }),
    base(19, "Arrive home - San Jose, Costa Rica", "flight", "15:45", { stop: "", zone: ZONES[3], location: "Juan Santamaria International Airport (SJO)", notes: "Costa Rica local time." })
  ];

  const SPANISH_TEXT = {
    "seed-03-1": { title: "Recogida del taxi al aeropuerto (reservado)", location: "Casa → aeropuerto SJO", notes: "Recogida a las 13:00; estar en SJO a más tardar a las 14:00." },
    "seed-03-2": { title: "Estar en el aeropuerto SJO antes de las 14:00", location: "Aeropuerto Internacional Juan Santamaría (SJO)" },
    "seed-03-3": { title: "Salida de SJO - Iberia IB0244", location: "Aeropuerto SJO", notes: "Vuelo nocturno a Madrid. Llegada: 4 de noviembre a las 10:15, hora local de Madrid. La llegada figura como un plan separado." },
    "seed-04-4": { title: "Llegada a Madrid - Iberia IB0244", location: "Aeropuerto Adolfo Suárez Madrid-Barajas (MAD)", notes: "Hora de llegada corregida: 10:15, no las 10:35 indicadas antes. Prever migración, equipaje y traslado al hotel." },
    "seed-04-5": { title: "AC Madrid Airport Hotel - instalarnos", notes: "Noche del 4 de noviembre; salida del hotel el 5. Confirmar el hotel y la dirección exactos y si permiten ingresar temprano." },
    "seed-04-6": { title: "Almuerzo ligero en el hotel", notes: "Hora flexible después de llegar." },
    "seed-04-7": { title: "Retirar la autocaravana", location: "C. Brasil, 9C, 28806 Alcalá de Henares, Madrid, España", notes: "Pendientes la hora de retiro y el traslado al local. Confirmar la entrega, el permiso para Portugal y dónde estacionar mientras dormimos en el hotel." },
    "seed-04-8": { title: "Cena - Asador 7 de Julio", notes: "Cena reservada; falta confirmar la dirección exacta del restaurante." },
    "seed-05-9": { title: "Salir de Madrid en autocaravana", location: "Madrid → Cáceres", notes: "Llegada prevista alrededor del mediodía. Prever combustible, descansos y estacionamiento; es una estimación, no una hora de llegada en tiempo real." },
    "seed-05-10": { title: "Almuerzo y paseo por el casco antiguo de Cáceres", location: "Casco antiguo de Cáceres", notes: "Almorzar y después recorrer el centro a pie. Salir a más tardar a las 16:00, hora de España." },
    "seed-05-11": { title: "Salir de Cáceres hacia Lisboa", location: "Cáceres → Lisboa Camping", notes: "El límite de salida usa la hora de España. Llegada prevista entre las 19:00 y las 20:00 de PORTUGAL, una hora menos. Revisar ruta, peajes y procedimiento de llegada tardía al camping." },
    "seed-05-12": { title: "Llegar a Lisboa Camping", location: "Área de autocaravanas Lisboa Camping", notes: "Ventana aproximada de llegada: de 19:00 a 20:00, hora local de Lisboa." },
    "seed-05-13": { title: "Lisboa Camping - noches en autocaravana", notes: "Noches del 5, 6 y 7 de noviembre; salida el día 8. Pendientes la reserva y la parcela exacta." },
    "seed-06-14": { title: "Recorrido de Lisboa en tuk-tuk", notes: "Pendientes el punto de encuentro, la duración y los detalles de la reserva." },
    "seed-06-15": { title: "Almuerzo - Time Out Market Lisboa", notes: "Nombre del lugar confirmado. Es un plan de almuerzo, no una reserva de mesa confirmada." },
    "seed-06-16": { title: "Explorar Lisboa - tarde flexible", notes: "Elegir las visitas sobre la marcha y dejar espacio para descansar." },
    "seed-07-17": { title: "Compras en outlets de Lisboa", notes: "Por elegir los outlets y la ruta. Prever el traslado a Rio de Mouro para cenar." },
    "seed-07-18": { title: "Cena - Plataforma (temática de Harry Potter)", location: "Largo Joaquim José Correia, Rio de Mouro 2635, Portugal", notes: "Restaurante Plataforma. Rio de Mouro está fuera del centro de Lisboa; planificar el traslado." },
    "seed-08-19": { title: "Salir de Lisboa hacia Sevilla", location: "Lisboa Camping → Sevilla", notes: "Salida en hora de Portugal; llegada prevista a Sevilla a las 15:00, hora de España. España tiene una hora más. Almorzar en un restaurante adecuado durante el recorrido." },
    "seed-08-20": { title: "Almuerzo en carretera hacia Sevilla", notes: "Restaurante y hora flexibles; verificar estacionamiento para la autocaravana." },
    "seed-08-21": { title: "Llegar a Sevilla y pasear", notes: "Llegada aproximada; hacer una visita corta si nos quedan energías." },
    "seed-08-22": { title: "Área Autocaravanas Sevilla - alojamiento", location: "Área Autocaravanas Sevilla", notes: "Noches del 8 y 9 de noviembre; salida el día 10. Reserva pendiente de confirmar." },
    "seed-09-23": { title: "Recorrido reservado en scooters por Sevilla", notes: "Hora aproximada de inicio. Confirmar punto de encuentro, duración y requisitos para participar." },
    "seed-09-24": { title: "Almuerzo en Sevilla" },
    "seed-09-25": { title: "Descanso - tarde libre" },
    "seed-10-26": { title: "Salir de Sevilla hacia Gibraltar / La Línea", location: "Sevilla → Alcaidesa Marina" },
    "seed-10-27": { title: "Alcaidesa Marina - noches en autocaravana", location: "Área de Autocaravanas Alcaidesa Marina", notes: "Noches del 10 y 11 de noviembre; salida el día 12. Está del lado español. Confirmar espacio, acceso fronterizo y reserva." },
    "seed-10-28": { title: "Centro de juegos en Gibraltar - tarde", notes: "Pendientes el nombre exacto del centro de juegos y su horario." },
    "seed-11-29": { title: "Recorrer Gibraltar", notes: "Elegir recorrido y atracciones; reserva y punto de encuentro aún no especificados." },
    "seed-12-30": { title: "Salir hacia Málaga y Granada", location: "Alcaidesa Marina → Málaga → Granada" },
    "seed-12-31": { title: "Parada para almorzar en Málaga", notes: "Hora y restaurante flexibles. No está previsto pasar la noche en Málaga." },
    "seed-12-32": { title: "Llegar a Granada - tarde de descanso", notes: "Hora de llegada aproximada." },
    "seed-12-33": { title: "Granada - alojamiento pendiente", notes: "Noches del 12 y 13 de noviembre. Se supone camping solo para planificar; cambiar si elegimos hotel. No hay lugar ni reserva especificados." },
    "seed-13-34": { title: "Pase reservado del tren eléctrico de día completo", notes: "Recorrer Granada. Pendientes el operador y los horarios. NO se supone que el pase incluya entrada a la Alhambra." },
    "seed-13-35": { title: "Visitar el conjunto de la Alhambra", notes: "Confirmar las entradas por separado y la hora de acceso a los Palacios Nazaríes, si corresponde. Ajustar el recorrido del tren a esa hora." },
    "seed-14-36": { title: "Salir de Granada", location: "Granada → Toledo → Madrid", notes: "Día de traslados ajustado: verificar la duración del viaje y si cabe el almuerzo en Toledo antes de devolver la autocaravana." },
    "seed-14-37": { title: "Almuerzo en Toledo", notes: "Hora y restaurante flexibles. Acortar la parada si hace falta para llegar a la devolución." },
    "seed-14-38": { title: "Llegada prevista a la zona de Madrid", location: "Zona de Madrid", notes: "Objetivo: de 14:00 a 15:00; no es una hora garantizada. El local de autocaravanas está en Alcalá de Henares, no en el centro de Madrid." },
    "seed-14-39": { title: "Devolver autocaravana ANTES de las 16:00", location: "C. Brasil, 9C, 28806 Alcalá de Henares, Madrid, España", notes: "Las 16:00 son el límite, NO la cita de llegada. Llegar antes para revisión y entrega. Pendientes la cita exacta y el traslado a Avis." },
    "seed-14-40": { title: "Retirar carro de Avis - Barajas T1", location: "Avis, Terminal 1, aeropuerto Madrid-Barajas", notes: "Después de devolver la autocaravana. Pendientes la cita y el traslado desde Alcalá de Henares." },
    "seed-14-41": { title: "Ingreso a Libere Madrid Palacio Real", location: "Apartamentos Libere Madrid Palacio Real", notes: "Después de retirar el carro. Confirmar instrucciones de ingreso y estacionamiento." },
    "seed-14-42": { title: "Libere Madrid Palacio Real - noches en apartamento", location: "Apartamentos Libere Madrid Palacio Real", notes: "Noches del 14 al 18 de noviembre; salida el día 19. Estado de reserva no especificado." },
    "seed-14-43": { title: "Cena - Le Petit Chef", notes: "Pendientes el local y la dirección exactos. Prever tiempo después de las entregas de vehículos y del ingreso al apartamento." },
    "seed-15-44": { title: "Autobús turístico de Madrid con paradas libres", notes: "Autobús de dos pisos para subir y bajar en las atracciones. Pendientes operador, entradas y recorrido." },
    "seed-16-45": { title: "Día de compras en Madrid", notes: "Elegir las tiendas y zonas de compras sobre la marcha." },
    "seed-17-46": { title: "Visitar atracciones de Madrid", notes: "Paseos flexibles; dejar tiempo para la cena." },
    "seed-17-47": { title: "Cena - The Roof Top 360", notes: "Verificar lugar y dirección. A las 20:00 ya habrá pasado el atardecer en noviembre; organizar una visita anterior por separado si queremos ver la puesta de sol." },
    "seed-18-48": { title: "Descansar, empacar y preparar el regreso", notes: "Empacar; revisar vuelo, terminal e instrucciones de devolución del carro; planificar la salida del alojamiento y el traslado al aeropuerto. No guardar aquí pasaportes ni datos de pago." },
    "seed-19-49": { title: "Devolver carro de Avis en el aeropuerto MAD", location: "Aeropuerto Madrid-Barajas", notes: "Pendientes el punto de devolución y la terminal. Prever revisión del carro, traslado a la terminal, registro y seguridad antes del vuelo de las 11:35." },
    "seed-19-50": { title: "Salida del vuelo desde Madrid", location: "Aeropuerto Adolfo Suárez Madrid-Barajas (MAD)", notes: "Pendientes el número de vuelo de regreso y la terminal. Llegada a SJO a las 15:45 de Costa Rica; figura como un plan separado." },
    "seed-19-51": { title: "Llegada a casa - San José, Costa Rica", location: "Aeropuerto Internacional Juan Santamaría (SJO)", notes: "Hora local de Costa Rica." }
  };
  const SEED = LEGACY_SEED.map(e => ({ ...e, ...SPANISH_TEXT[e.id] }));
  function migrateSpanish(events) {
    return events.map(event => {
      const original = LEGACY_SEED.find(e => e.id === event.id);
      if (!original) return { ...event };
      const translated = SEED.find(e => e.id === event.id);
      const result = { ...event };
      for (const field of ["title", "notes", "location"]) {
        if (event[field] === original[field]) result[field] = translated[field];
      }
      return result;
    });
  }

  function validateEvents(events) {
    if (!Array.isArray(events) || events.length > 2000) throw new Error("La copia debe contener una lista de hasta 2.000 planes.");
    const ids = new Set();
    const dateOK = value => typeof value === "string" && /^2026-11-(0[1-9]|[12]\d|30)$/.test(value);
    const timeOK = value => typeof value === "string" && (value === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
    for (const e of events) {
      if (!e || typeof e !== "object" || typeof e.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(e.id) || ids.has(e.id)) throw new Error("Cada plan necesita un identificador único con letras, números, guiones o guiones bajos.");
      ids.add(e.id);
      for (const [key, max] of Object.entries({ title: 200, location: 500, notes: 5000, url: 2000 })) {
        if (typeof e[key] !== "string" || e[key].length > max) throw new Error(`Revisá el campo «${{ title: "título", location: "lugar", notes: "notas", url: "enlace" }[key]}» de uno de los planes.`);
      }
      if (!e.title.trim()) throw new Error("Escribí un título para cada plan.");
      if (!dateOK(e.date) || !dateOK(e.endDate) || e.endDate < e.date) throw new Error("Las fechas deben ser de noviembre de 2026 y la fecha final no puede ser anterior a la inicial.");
      if (!timeOK(e.time) || !timeOK(e.endTime) || (e.endTime && !e.time) || (e.endTime && e.date === e.endDate && e.endTime <= e.time)) throw new Error("Revisá las horas de inicio y finalización.");
      if (!ZONES.includes(e.zone) || !TYPES.includes(e.type) || !STATUSES.includes(e.status) || !["", "hotel", "rv"].includes(e.stay) || !REMINDERS.includes(e.reminder) || typeof e.done !== "boolean") throw new Error("Revisá la categoría, zona horaria, estado, alojamiento o recordatorio.");
      if (e.stay && e.type !== "stay") throw new Error("Elegí la categoría de alojamiento para indicar dónde pasar la noche.");
      if (typeof e.stop !== "string" || (e.stop && !STOPS.some(s => s.id === e.stop))) throw new Error("La parada de la ruta no existe.");
      if (e.url) {
        if (/[\r\n]/.test(e.url)) throw new Error("Los enlaces no pueden contener saltos de línea.");
        let url;
        try { url = new URL(e.url); } catch { throw new Error("Usá un enlace completo que empiece por http:// o https://."); }
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("Los enlaces deben empezar por http:// o https://.");
      }
    }
    return events;
  }
  function dayAfter(date) {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  function localInstant(date, time, zone) {
    const desired = Date.parse(`${date}T${time || "09:00"}:00Z`);
    let instant = desired;
    const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    for (let i = 0; i < 3; i++) {
      const p = Object.fromEntries(formatter.formatToParts(instant).map(x => [x.type, x.value]));
      const displayed = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
      instant += desired - displayed;
    }
    return instant;
  }
  function eventsOn(events, date) {
    return events.filter(e => e.date <= date && e.endDate >= date).sort((a, b) => {
      if (!a.time && b.time) return 1;
      if (a.time && !b.time) return -1;
      return localInstant(a.date, a.time, a.zone) - localInstant(b.date, b.time, b.zone) || a.title.localeCompare(b.title, "es");
    });
  }
  function icsEscape(value) {
    return value.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
  }
  function foldLine(line) {
    const encoder = new TextEncoder();
    let part = "", result = [], size = 0;
    for (const char of line) {
      const bytes = encoder.encode(char).length;
      if (size + bytes > 75) { result.push(part); part = " "; size = 1; }
      part += char; size += bytes;
    }
    result.push(part);
    return result.join("\r\n");
  }
  function buildICS(events, now = Date.now()) {
    validateEvents(events);
    const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Atlas//Noviembre Iberico//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
    for (const e of events.filter(e => !e.done)) {
      lines.push("BEGIN:VEVENT", `UID:${e.id}@iberian-november.local`, `DTSTAMP:${stamp(now)}`);
      if (e.time) {
        const start = localInstant(e.date, e.time, e.zone);
        const end = e.endTime ? localInstant(e.endDate, e.endTime, e.zone) : e.endDate !== e.date ? localInstant(e.endDate, e.time, e.zone) + 3600000 : start + 3600000;
        lines.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`);
      } else {
        lines.push(`DTSTART;VALUE=DATE:${e.date.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${dayAfter(e.endDate).replace(/-/g, "")}`);
      }
      lines.push(`SUMMARY:${icsEscape(e.title)}`, `LOCATION:${icsEscape(e.location)}`, `DESCRIPTION:${icsEscape(`${e.notes}\nEstado: ${STATUS_LABELS[e.status]}. Zona horaria: ${e.zone}. ${e.time ? "Duración predeterminada de una hora si no se indica hora final." : "Evento de todo el día."}`)}`);
      if (e.url) lines.push(`URL:${e.url}`);
      if (e.reminder >= 0) lines.push("BEGIN:VALARM", `TRIGGER;VALUE=DATE-TIME:${stamp(localInstant(e.date, e.time, e.zone) - e.reminder * 60000)}`, "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(e.title)}`, "END:VALARM");
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    return lines.map(foldLine).join("\r\n") + "\r\n";
  }
  const api = { ZONES, TYPES, STATUSES, STATUS_LABELS, REMINDERS, STOPS, SEED, LEGACY_SEED, migrateSpanish, validateEvents, dayAfter, localInstant, eventsOn, buildICS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Trip = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
