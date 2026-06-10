(function () {
  "use strict";

  const {
    $, $all, esc, money, parseMoney, dateTime, todayInput, plateKey, isValidPlate,
    uidSafe, coords, pointFrom, routeKm, mapsRouteUrl, normalizeUrl, toast, statusClass,
    statusKey, statusLabel, isFinalStatus: utilIsFinalStatus, maskPhone, phoneWhatsappUrl,
    geometryToFirestore, setupCollapsiblePanels
  } = window.JM.utils;
  const { auth, secondaryAuth, db, ts, arrayUnion, emailIsAdmin, getRealtimeDb, rtdbKey } = window.JM.firebase;
  const cfg = window.JM_CONFIG || {};
  const SYSTEM_SIGNATURE = "";
  const LOGIN_FLOW_VERSION = "jm-v28-5-firestore-callsize-motorista";
  let trackerTimer = null;
  let trackerBusy = false;
  let mapRefreshTimer = null;

  function readLocal(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value == null || value === "" ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function writeLocal(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }

  const state = {
    user: null,
    profile: null,
    vehicles: {},
    calls: {},
    users: {},
    expenses: {},
    transactions: {},
    maintenance: {},
    customers: {},
    integrationInbox: {},
    trackerProviders: {},
    settings: {},
    addresses: { origin: null, destination: null, waypoints: [] },
    smartRoute: null,
    routePricing: null,
    selectedCallId: null,
    selectedVehicleId: null,
    selectedDossierCallId: null,
    operationFilter: "ativos",
    operationPriorityFilter: "",
    operationInsuranceFilter: "",
    operationDriverFilter: "",
    operationVehicleFilter: "",
    pendingIntegrationId: null,
    editingCallId: null,
    editingUserId: null,
    editingTransactionId: null,
    editingMaintenanceId: null,
    editingCustomerId: null,
    editingPaymentId: null,
    mobileGps: { vehicles: {}, calls: {} },
    mobileGpsUnsubs: [],
    publicChatMessages: {},
    publicChatUnsubs: {},
    mapProvider: readLocal("jm.map.provider", "google_road"),
    sidebarCollapsed: readLocal("jm.sidebar.collapsed", "false") === "true",
    aiDrafts: [],
    insuranceClosingGroups: {}
  };

  const unsubscribers = [];
  const OFFICE_ROLES = ["admin", "finance", "gestor", "owner", "manager", "gerente", "auxiliar", "atendente"];
  const OWNER_ROLES = ["admin", "superadmin", "gestor", "owner", "manager"];
  const FINANCE_ROLES = ["admin", "superadmin", "gestor", "owner", "manager", "finance"];
  const FLEET_ROLES = ["admin", "superadmin", "gestor", "owner", "manager", "gerente"];
  const OPERATIONS_ROLES = ["admin", "superadmin", "gestor", "owner", "manager", "gerente", "auxiliar", "atendente"];
  const DRIVER_ROLES = ["driver", "motorista"];

  function normalizedRole(role) {
    return String(role || "").toLowerCase().trim();
  }

  function isOffice() {
    return state.profile && OFFICE_ROLES.includes(normalizedRole(state.profile.role));
  }

  function hasRole(list) {
    return state.profile && list.includes(normalizedRole(state.profile.role));
  }

  function canOwnCompany() {
    return hasRole(OWNER_ROLES);
  }

  function isAdmin() {
    return canOwnCompany();
  }

  function canOperateCalls() {
    return hasRole(OPERATIONS_ROLES) || hasRole(FINANCE_ROLES);
  }

  function canManageFinance() {
    return hasRole(FINANCE_ROLES);
  }

  function canManageFleet() {
    return hasRole(FLEET_ROLES);
  }

  function canManageTeam() {
    return canOwnCompany();
  }

  function canSeeSensitiveFinance() {
    return canManageFinance();
  }

  function isFinalStatus(status) {
    return utilIsFinalStatus(status);
  }

  function operationalStatus(status) {
    return statusLabel(status);
  }

  function operationalKey(status) {
    return statusKey(status);
  }

  function priorityWeight(call) {
    const p = String(call && call.priority || "normal").toLowerCase();
    if (p === "urgente") return 0;
    if (p === "alta") return 1;
    return 2;
  }

  function minutesSince(value) {
    if (!value) return null;
    const d = value && typeof value.toDate === "function" ? value.toDate() : new Date(value);
    const ms = Date.now() - d.getTime();
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, Math.round(ms / 60000));
  }

  function routeForCall(call, preferredVehicleId) {
    const vehicle = state.vehicles[preferredVehicleId || call && call.vehicleId] || null;
    return call && (call.routeExternalUrl || call.routeUrl) || mapsRouteUrl(call, vehicle);
  }

  function quickCallLinks(call, vehicle, options) {
    options = options || {};
    if (!call) return "";
    const stop = options.stopPropagation ? ` onclick="event.stopPropagation()"` : "";
    const routeUrl = call.routeExternalUrl || call.routeUrl || mapsRouteUrl(call, vehicle || state.vehicles[call.vehicleId] || {});
    const publicToken = call.publicToken && !call.publicRevoked ? call.publicToken : "";
    const links = [];
    if (routeUrl) links.push(`<a class="btn mini" target="_blank" rel="noopener noreferrer" href="${esc(routeUrl)}"${stop}>Rota</a>`);
    if (publicToken) {
      links.push(`<a class="btn mini" target="_blank" rel="noopener noreferrer" href="${esc(publicClientUrl(publicToken))}"${stop}>Cliente</a>`);
      links.push(`<a class="btn mini" target="_blank" rel="noopener noreferrer" href="${esc(publicReportUrl(publicToken))}"${stop}>Laudo</a>`);
    }
    return links.length ? `<div class="call-quick-links">${links.join("")}</div>` : "";
  }

  function canManageTracker() {
    return canOwnCompany() || normalizedRole(state.profile && state.profile.role) === "gerente";
  }

  function activeCloudinaryConfig() {
    return Object.assign({}, cfg.cloudinary || {}, state.settings.cloudinary || {});
  }

  function mergeNonEmpty(base, override) {
    const out = Object.assign({}, base || {});
    Object.entries(override || {}).forEach(([key, value]) => {
      if (value === "" || value == null) return;
      if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
        out[key] = Object.assign({}, out[key] || {}, value);
      } else {
        out[key] = value;
      }
    });
    return out;
  }

  function activeMapSettings() {
    const base = mergeNonEmpty(cfg.map || {}, state.settings.map || state.settings.googleMaps || {});
    if (!base.searchSuffix && cfg.empresa && cfg.empresa.cidadeBase) base.searchSuffix = cfg.empresa.cidadeBase + ", Brasil";
    base.provider = state.mapProvider || base.provider || "google_road";
    return base;
  }

  function activeTrackerSettings() {
    return mergeNonEmpty(cfg.tracker || {}, state.settings.tracker || {});
  }

  function activeMobileGpsSettings() {
    const base = mergeNonEmpty(cfg.mobileGps || {}, state.settings.mobileGps || {});
    return Object.assign({ enabled: false, backend: "firestore", databaseURL: "", pollingMs: 10000, minIntervalMs: 20000, minDistanceMeters: 25 }, base || {});
  }

  function isMobileGpsEnabled() {
    const gps = activeMobileGpsSettings();
    return gps.enabled === true || gps.enabled === "true";
  }

  function isMobileGpsRealtime() {
    const gps = activeMobileGpsSettings();
    return isMobileGpsEnabled() && String(gps.backend || "firestore") === "realtime_database" && !!String(gps.databaseURL || "").trim();
  }

  function clearMobileGpsRealtimeListeners() {
    (state.mobileGpsUnsubs || []).splice(0).forEach((fn) => {
      try { fn(); } catch (_) {}
    });
    state.mobileGps = { vehicles: {}, calls: {} };
  }

  function scheduleMapRefresh(delay) {
    clearTimeout(mapRefreshTimer);
    mapRefreshTimer = setTimeout(() => {
      try { refreshMaps(); } catch (err) { console.warn("Falha ao atualizar mapa", err); }
    }, delay == null ? 120 : delay);
  }

  function startMobileGpsRealtimeListeners() {
    clearMobileGpsRealtimeListeners();
    if (!isMobileGpsRealtime() || !getRealtimeDb) return;
    const gps = activeMobileGpsSettings();
    const rtdb = getRealtimeDb(gps.databaseURL);
    if (!rtdb) return;
    const refs = [
      { key: "vehicles", ref: rtdb.ref("mobileGps/vehicles") },
      { key: "calls", ref: rtdb.ref("mobileGps/calls") }
    ];
    refs.forEach((item) => {
      const handler = (snap) => {
        const value = snap.val() || {};
        state.mobileGps[item.key] = value;
        scheduleMapRefresh(80);
      };
      item.ref.on("value", handler, (err) => console.warn("Falha RTDB GPS", item.key, err));
      state.mobileGpsUnsubs.push(() => item.ref.off("value", handler));
    });
  }

  function visibleRows(rows) {
    return Object.values(rows || {}).filter((row) => row && !row.deletedAt);
  }

  function storePoint(value) {
    const point = pointFrom(value);
    if (!point) return null;
    if (Math.abs(Number(point.lat)) < 0.000001 && Math.abs(Number(point.lng)) < 0.000001) return null;
    return { lat: point.lat, lng: point.lng };
  }

  function usefulPoint(value) {
    return storePoint(value);
  }

  function storeAddress(address) {
    if (!address) return null;
    return {
      label: address.label || "",
      coords: storePoint(address.coords),
      source: address.source || "",
      provider: address.provider || "",
      raw: address.raw || "",
      externalUrl: address.externalUrl || "",
      resolvedAt: address.resolvedAt || ""
    };
  }

  function storeRoute(route) {
    if (!route) return null;
    return {
      source: route.source || "",
      label: route.label || "",
      distanceMeters: Number(route.distanceMeters || 0),
      distanceText: route.distanceText || "",
      durationSeconds: Number(route.durationSeconds || 0),
      durationText: route.durationText || "",
      durationTrafficText: route.durationTrafficText || "",
      start: storePoint(route.start),
      end: storePoint(route.end),
      geometry: geometryToFirestore(route.geometry),
      isPrecise: !!route.isPrecise,
      fallbackReason: route.fallbackReason || "",
      calculatedAt: route.calculatedAt || new Date().toISOString()
    };
  }

  function storeRouteMetrics(best) {
    if (!best) return null;
    const pricingRoute = routeForPricingFromBest(best);
    return {
      recommendedVehicleId: best.vehicle && best.vehicle.id || "",
      recommendedVehiclePlate: best.vehicle && best.vehicle.placa || "",
      distanceKm: pricingRoute ? round2(Number(pricingRoute.distanceMeters || 0) / 1000 || routeDistanceKmFromGeometry(pricingRoute.geometry)) : 0,
      durationMin: pricingRoute ? Math.round(Number(pricingRoute.durationSeconds || 0) / 60) : 0,
      source: pricingRoute && pricingRoute.source || "",
      bestToOrigin: storeRoute(best.toOrigin),
      serviceRoute: storeRoute(best.serviceRoute),
      fullRoute: storeRoute(best.fullRoute),
      kmToOrigin: Number(best.kmToOrigin || 0),
      minutesToOrigin: Number(best.minutesToOrigin || 0),
      score: Number(best.score || 0),
      routeUrl: best.routeUrl || "",
      calculatedAt: state.smartRoute && state.smartRoute.calculatedAt || new Date().toISOString(),
      algorithm: "tracker_position + openstreetmap_osrm_route + fallback_haversine + status_penalty"
    };
  }

  function payloadSizeBytes(value) {
    try {
      const text = JSON.stringify(value || {});
      return window.Blob ? new Blob([text]).size : text.length;
    } catch (_) {
      return 0;
    }
  }

  function stripStoredRouteGeometry(route) {
    if (!route || !route.geometry) return route || null;
    const out = Object.assign({}, route);
    out.geometryPointCount = route.geometry.originalPointCount || route.geometry.coordinates && route.geometry.coordinates.length || 0;
    out.geometryStored = false;
    delete out.geometry;
    return out;
  }

  function prepareCallDataForFirestore(data) {
    let out = Object.assign({}, data || {});
    out.routeStorageMode = out.routeGeometry ? "simplified_geometry" : "summary_only";
    out.routePayloadBytes = payloadSizeBytes(out);
    if (out.routePayloadBytes <= 900000) return out;

    const metrics = Object.assign({}, out.routeMetrics || {});
    metrics.bestToOrigin = stripStoredRouteGeometry(metrics.bestToOrigin);
    metrics.serviceRoute = stripStoredRouteGeometry(metrics.serviceRoute);
    metrics.fullRoute = stripStoredRouteGeometry(metrics.fullRoute);
    out.routeMetrics = metrics;
    if (out.routeGeometry) {
      out.routeGeometryPointCount = out.routeGeometry.originalPointCount || out.routeGeometry.coordinates && out.routeGeometry.coordinates.length || 0;
      out.routeGeometry = null;
    }
    out.routeStorageMode = "summary_only_oversize_guard";
    out.routeStorageWarning = "Geometria completa nao foi salva no chamado para respeitar limite de 1 MB do Firestore.";
    out.routePayloadBytes = payloadSizeBytes(out);
    return out;
  }

  function personName() {
    return state.profile && (state.profile.nome || state.profile.email) || state.user && state.user.email || "sistema";
  }

  async function writeAudit(action, collectionName, docId, oldData, reason) {
    try {
      await db.collection("auditLogs").add({
        action,
        collection: collectionName,
        docId,
        reason: reason || "",
        oldData: oldData || null,
        profileRole: state.profile && state.profile.role || "",
        byUid: state.user && state.user.uid || "",
        byEmail: state.user && state.user.email || "",
        byName: personName(),
        createdAt: new Date().toISOString()
      });
    } catch (err) {
      console.warn("Falha ao gravar auditoria", err);
      toast("A ação foi preparada, mas a auditoria foi bloqueada. Publique as firestore.rules da V16 antes de operar exclusões.", "danger");
      throw err;
    }
  }

  async function softDeleteDoc(collectionName, id, oldData, reason) {
    await writeAudit("delete", collectionName, id, oldData, reason);
    await db.collection(collectionName).doc(id).set({
      deletedAt: new Date().toISOString(),
      deletedBy: state.user.uid,
      deletedByEmail: state.user.email,
      auditReason: reason || ""
    }, { merge: true });
  }


  function sourceDocId(prefix, id) {
    return String(prefix || "doc") + "_" + String(id || "").replace(/[\\/\s]+/g, "_");
  }

  function statusLower(value) {
    return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function statusMeansReceived(value) {
    return /recebido|pago|baixado|liquidado/.test(statusLower(value));
  }

  function statusMeansOpen(value) {
    return /receber|pagar|pendente|faturar|aberto/.test(statusLower(value));
  }

  function normalizeCostText(value) {
    return statusLower(value).replace(/[^a-z0-9]+/g, " ").trim();
  }

  function isMaintenanceExpenseType(type, notes) {
    const text = normalizeCostText(String(type || "") + " " + String(notes || ""));
    return /manutenc|revis|oleo|pneu|freio|suspens|eletric|mecanica|motor|cambio|guincho|munck|plataforma|borrachar|peca|pecas/.test(text);
  }

  function isVehicleCostType(type, notes) {
    const text = normalizeCostText(String(type || "") + " " + String(notes || ""));
    return /combustivel|diesel|gasolina|etanol|arla|pedagio|estacionamento|lavagem|alimentacao|manutenc|revis|oleo|pneu|freio|suspens|eletric|borrachar|mecanica|motor|cambio|guincho|munck|plataforma|peca|pecas/.test(text);
  }

  function vehicleCostKind(type, notes) {
    return isMaintenanceExpenseType(type, notes) ? "maintenance" : isVehicleCostType(type, notes) ? "operational" : "general";
  }

  function vehicleCostKindLabel(kind) {
    if (kind === "maintenance") return "Manutenção";
    if (kind === "operational") return "Operacional";
    return "Geral";
  }

  function round2(value) {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
  }

  function trunc2(value) {
    return Math.trunc((Number(value || 0) + Number.EPSILON) * 100) / 100;
  }

  function pct(value) {
    const n = parseMoney(value || 0);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  function towDefaults(type) {
    return String(type || "leve") === "pesado"
      ? { baseOut: 463.86, kmValue: 16.66, label: "Pesado acima de 1.500 kg / van / coletivo / carga / semirreboque acima de 750 kg" }
      : { baseOut: 253.22, kmValue: 8.51, label: "Leve até 1.500 kg / moto / semirreboque até 750 kg" };
  }

  function brNumber(value) {
    if (value == null || value === "") return "";
    return String(Number(value || 0).toFixed(2)).replace(".", ",");
  }

  function setPriceMode(mode, locked) {
    const el = $("callPrice");
    if (!el) return;
    el.dataset.priceMode = mode || "";
    el.dataset.manualPriceLocked = locked ? "true" : "false";
  }

  function setOfficialPriceField(value, mode) {
    setValue("callPrice", brNumber(value || 0));
    setPriceMode(mode || "suggested", false);
  }

  function preserveManualPrice(callData) {
    const el = $("callPrice");
    const raw = callData && callData.rawPrice != null ? callData.rawPrice : el && el.value || "";
    const mode = callData && callData.priceMode || el && el.dataset.priceMode || "";
    const hasValue = String(raw || "").trim() !== "" && parseMoney(raw) > 0;
    const locked = hasValue && mode !== "auto" && mode !== "suggested";
    return {
      manualValue: hasValue ? parseMoney(raw) : 0,
      manualPriceLocked: locked,
      priceMode: locked ? "manual" : mode || (hasValue ? "suggested" : "auto")
    };
  }

  function activePricingSettings(callData) {
    const tow = callData && callData.towPricing || {};
    const defaults = towDefaults(tow.tipo || "leve");
    const base = {
      enabled: true,
      minimumFare: 0,
      baseFare: Number(tow.valorSaida || defaults.baseOut || 0),
      pricePerKm: Number(tow.valorKmAdicional || defaults.kmValue || 0),
      pricePerLoadedKm: 0,
      pricePerReturnKm: Number(tow.valorKmAdicional || defaults.kmValue || 0),
      includeReturnKm: !!(tow.cobrarIdaVolta ?? tow.idaVolta ?? true),
      includeTolls: true,
      defaultVehicleClass: tow.tipo || "leve",
      nightSurchargePercent: 0,
      weekendSurchargePercent: 0,
      insuranceDefaultMarkup: 0,
      privateCustomerDefaultMarkup: 0,
      roundingMode: "up_1",
      tollRouteToleranceMeters: 500,
      notes: "Configuravel em settings/integrations.pricing"
    };
    return mergeNonEmpty(
      mergeNonEmpty(base, cfg.pricing || cfg.routePricing || {}),
      state.settings.pricing || state.settings.routePricing || {}
    );
  }

  function activeTollPlazas() {
    const localRows = window.JM_TOLL_PLAZAS || window.JM && window.JM.tollPlazas || [];
    const settingsRows = state.settings.tollPlazas || state.settings.tolls || state.settings.pricing && state.settings.pricing.tollPlazas || [];
    const rows = []
      .concat(Array.isArray(localRows) ? localRows : Object.values(localRows || {}))
      .concat(Array.isArray(settingsRows) ? settingsRows : Object.values(settingsRows || {}));
    const out = {};
    rows.forEach((row, index) => {
      const plaza = normalizeTollPlaza(row, index);
      if (plaza) out[plaza.id] = plaza;
    });
    return Object.values(out);
  }

  function normalizeTollPlaza(row, index) {
    if (!row) return null;
    const point = pointFrom({
      lat: row.lat ?? row.latitude,
      lng: row.lng ?? row.longitude ?? row.lon
    });
    if (!point) return null;
    const id = String(row.id || row.codigo || row.name || row.nome || "toll_" + index).trim();
    return {
      id,
      name: row.name || row.nome || id,
      road: row.road || row.rodovia || "",
      km: row.km || "",
      lat: point.lat,
      lng: point.lng,
      direction: row.direction || row.sentido || "",
      tariffs: row.tariffs || row.tarifas || row.tarifaPorClasse || {},
      amount: Number(row.amount ?? row.tarifa ?? row.valor ?? row.value ?? 0),
      active: row.active !== false && row.ativo !== false,
      demo: row.demo === true,
      observation: row.observation || row.observacao || row.obs || "",
      source: row.source || row.fonte || "",
      sourceUpdatedAt: row.sourceUpdatedAt || row.dataAtualizacao || row.updatedAt || ""
    };
  }

  function routeGeometryPoints(geometry) {
    const coordinates = geometry && geometry.type === "LineString" && Array.isArray(geometry.coordinates)
      ? geometry.coordinates
      : Array.isArray(geometry) ? geometry : [];
    return coordinates.map((pair) => {
      if (Array.isArray(pair) && pair.length >= 2) {
        const lng = Number(pair[0]);
        const lat = Number(pair[1]);
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
      }
      if (pair && typeof pair === "object") {
        const lat = Number(pair.lat ?? pair.latitude);
        const lng = Number(pair.lng ?? pair.longitude ?? pair.lon);
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
      }
      return null;
    }).filter(Boolean);
  }

  function metersBetweenPoints(a, b) {
    const pa = pointFrom(a);
    const pb = pointFrom(b);
    if (!pa || !pb) return 0;
    const R = 6371000;
    const dLat = (pb.lat - pa.lat) * Math.PI / 180;
    const dLng = (pb.lng - pa.lng) * Math.PI / 180;
    const la1 = pa.lat * Math.PI / 180;
    const la2 = pb.lat * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function distancePointToSegmentMeters(point, start, end) {
    const p = pointFrom(point);
    const a = pointFrom(start);
    const b = pointFrom(end);
    if (!p || !a || !b) return Infinity;
    const latRef = p.lat * Math.PI / 180;
    const metersPerLat = 111320;
    const metersPerLng = Math.max(1, 111320 * Math.cos(latRef));
    const px = p.lng * metersPerLng;
    const py = p.lat * metersPerLat;
    const ax = a.lng * metersPerLng;
    const ay = a.lat * metersPerLat;
    const bx = b.lng * metersPerLng;
    const by = b.lat * metersPerLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (!len2) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function distancePointToRouteMeters(point, routeGeometry) {
    const points = routeGeometryPoints(routeGeometry);
    if (!pointFrom(point) || points.length < 2) return Infinity;
    let best = Infinity;
    for (let i = 1; i < points.length; i += 1) {
      best = Math.min(best, distancePointToSegmentMeters(point, points[i - 1], points[i]));
    }
    return best;
  }

  function tollAmountForClass(plaza, vehicleClass) {
    const cls = String(vehicleClass || "").toLowerCase();
    const tariffs = plaza && plaza.tariffs || {};
    const value = tariffs[cls] ?? tariffs.default ?? tariffs.padrao ?? plaza.amount ?? 0;
    return round2(parseMoney(value || 0));
  }

  function tollConfidence(distanceMeters, toleranceMeters) {
    if (distanceMeters <= Math.min(300, toleranceMeters)) return "alta";
    if (distanceMeters <= Math.min(700, toleranceMeters)) return "media";
    return "baixa";
  }

  function findTollsAlongRoute(routeGeometry, tollPlazas, options) {
    const settings = options || {};
    const toleranceMeters = Number(settings.toleranceMeters || settings.tollRouteToleranceMeters || 500);
    const vehicleClass = String(settings.vehicleClass || settings.defaultVehicleClass || "leve").toLowerCase();
    const geometryPoints = routeGeometryPoints(routeGeometry);
    if (geometryPoints.length < 2) return [];
    const seen = {};
    return (tollPlazas || []).filter((plaza) => plaza && plaza.active !== false).map((plaza) => {
      const distance = distancePointToRouteMeters({ lat: plaza.lat, lng: plaza.lng }, routeGeometry);
      if (!Number.isFinite(distance) || distance > toleranceMeters) return null;
      const key = plaza.id || plaza.name + "_" + plaza.lat + "_" + plaza.lng;
      if (seen[key]) return null;
      seen[key] = true;
      return {
        id: plaza.id,
        name: plaza.name,
        road: plaza.road,
        km: plaza.km,
        lat: plaza.lat,
        lng: plaza.lng,
        amount: tollAmountForClass(plaza, vehicleClass),
        vehicleClass,
        direction: plaza.direction || "",
        confidence: tollConfidence(distance, toleranceMeters),
        distanceFromRouteMeters: Math.round(distance),
        source: plaza.source || "",
        sourceUpdatedAt: plaza.sourceUpdatedAt || "",
        observation: plaza.observation || ""
      };
    }).filter(Boolean);
  }

  function routeDistanceKmFromGeometry(routeGeometry) {
    const points = routeGeometryPoints(routeGeometry);
    let meters = 0;
    for (let i = 1; i < points.length; i += 1) meters += metersBetweenPoints(points[i - 1], points[i]);
    return Math.round((meters / 1000) * 100) / 100;
  }

  function routeForPricingFromBest(best) {
    return best && (best.serviceRoute || best.fullRoute || best.toOrigin) || null;
  }

  function bestRouteForPricing() {
    return routeForPricingFromBest(bestSmartRoute());
  }

  function applyRoundingMode(value, mode) {
    const n = round2(value || 0);
    if (mode === "up_10") return Math.ceil(n / 10) * 10;
    if (mode === "up_5") return Math.ceil(n / 5) * 5;
    if (mode === "up_1") return Math.ceil(n);
    return n;
  }

  function currentCallDataForPricing(towPricing) {
    const priceEl = $("callPrice");
    return {
      rawPrice: priceEl && priceEl.value || "",
      priceMode: priceEl && priceEl.dataset.priceMode || "",
      towPricing: towPricing || calculateTowPricing(),
      extraKm: $("callExtraKm") ? parseMoney($("callExtraKm").value) : 0,
      source: $("callSource") ? $("callSource").value : "",
      serviceType: $("callType") ? $("callType").value : ""
    };
  }

  function calculateRoutePricing(callData, routeMetrics, pricingSettings) {
    const now = new Date().toISOString();
    const settings = pricingSettings || activePricingSettings(callData);
    const route = routeMetrics && (routeMetrics.route || routeMetrics.serviceRoute || routeMetrics.fullRoute || routeMetrics.bestToOrigin) || routeMetrics || {};
    const geometry = route.geometry || route.routeGeometry || null;
    const distanceKm = round2(Number(route.distanceMeters || 0) / 1000 || routeDistanceKmFromGeometry(geometry));
    const durationMin = Math.round(Number(route.durationSeconds || 0) / 60);
    const vehicleClass = String(settings.defaultVehicleClass || callData && callData.towPricing && callData.towPricing.tipo || "leve").toLowerCase();
    const tollPlazas = activeTollPlazas();
    const detectedPlazas = findTollsAlongRoute(geometry, tollPlazas, {
      toleranceMeters: settings.tollRouteToleranceMeters,
      vehicleClass
    });
    const oneWayTollTotal = round2(detectedPlazas.reduce((sum, plaza) => sum + Number(plaza.amount || 0), 0));
    const tollMultiplier = settings.includeReturnKm ? 2 : 1;
    const tollTotal = settings.includeTolls !== false ? round2(oneWayTollTotal * tollMultiplier) : 0;
    const baseFare = Number(settings.baseFare || 0);
    const kmFare = Number(settings.pricePerLoadedKm || settings.pricePerKm || 0);
    const minimumFare = Number(settings.minimumFare || 0);
    const extraKm = Number(callData && callData.extraKm || 0);
    const billedKm = Math.max(0, distanceKm + extraKm);
    const returnKm = settings.includeReturnKm ? distanceKm : 0;
    const returnFare = settings.includeReturnKm ? Number(settings.pricePerReturnKm ?? kmFare) : 0;
    let suggested = baseFare + billedKm * kmFare + returnKm * returnFare + tollTotal;
    if (minimumFare > 0 && suggested < minimumFare) suggested = minimumFare;
    suggested = applyRoundingMode(suggested, settings.roundingMode || "none");
    const manual = preserveManualPrice(callData);
    const finalValue = manual.manualPriceLocked ? manual.manualValue : suggested;
    const warning = !geometry
      ? "Rota sem geometria; confira o calculo antes do fechamento."
      : !tollPlazas.filter((p) => p.active !== false).length
        ? "Nao ha base ativa de pedagios cadastrada."
        : !detectedPlazas.length
          ? "Nenhuma praca cadastrada foi encontrada perto da rota."
          : "Pedagio estimado por pracas cadastradas. Confira valores antes do fechamento.";
    const costPerKm = Number(settings.costPerKm || settings.operationalCostPerKm || 0);
    const estimatedCostTotal = round2(billedKm * costPerKm + tollTotal);
    return {
      routeMetrics: {
        distanceKm,
        durationMin,
        source: route.source || "route_pricing",
        calculatedAt: now
      },
      tollEstimate: {
        total: tollTotal,
        oneWayTotal: oneWayTollTotal,
        multiplier: tollMultiplier,
        plazas: detectedPlazas,
        source: "local_toll_table",
        calculatedAt: now,
        warning
      },
      pricingSuggestion: {
        suggestedServiceValue: suggested,
        manualValue: manual.manualValue,
        finalValue,
        tollTotal,
        distanceKm,
        baseFare,
        kmFare,
        minimumFare,
        extraKm,
        returnKm,
        calculationMode: "base_km_return_toll_settings",
        calculatedAt: now,
        source: "osrm_openstreetmap + local_toll_table + settings/pricing",
        priceMode: manual.manualPriceLocked ? "manual" : manual.priceMode || "auto",
        manualPriceLocked: manual.manualPriceLocked
      },
      costEstimate: costPerKm > 0 ? {
        costPerKm,
        fuelOrOperationalCost: round2(billedKm * costPerKm),
        tollCost: tollTotal,
        totalEstimatedCost: estimatedCostTotal,
        expectedProfit: round2(finalValue - estimatedCostTotal),
        calculatedAt: now
      } : null
    };
  }

  function formatPricingSummary(pricingResult) {
    const suggestion = pricingResult && pricingResult.pricingSuggestion;
    const toll = pricingResult && pricingResult.tollEstimate;
    if (!suggestion || !toll) return "Calcule a rota para ver preco sugerido e pedagios.";
    const diff = round2(suggestion.suggestedServiceValue - suggestion.manualValue);
    if (suggestion.manualPriceLocked) {
      return "Valor manual informado: " + money(suggestion.manualValue) + ". Preco sugerido pela rota: " + money(suggestion.suggestedServiceValue) + ", incluindo " + money(toll.total) + " de pedagio. Diferenca: " + money(diff) + ". O valor oficial foi mantido.";
    }
    return "Preco sugerido pela rota: " + money(suggestion.suggestedServiceValue) + ", incluindo " + money(toll.total) + " de pedagio.";
  }

  function renderRoutePricingSummary(pricingResult) {
    const el = $("routePricingSummary");
    if (!el) return;
    if (!pricingResult) {
      el.className = "route-pricing-summary small muted";
      el.innerHTML = "Preco sugerido e pedagio aparecem aqui apos calcular a rota.";
      return;
    }
    const suggestion = pricingResult.pricingSuggestion;
    const toll = pricingResult.tollEstimate;
    const plazas = toll.plazas && toll.plazas.length
      ? toll.plazas.map((p) => `<li>${esc(p.name)} ${p.road ? " - " + esc(p.road) : ""}: <b>${money(p.amount || 0)}</b> <span class="muted">(${p.distanceFromRouteMeters}m, conf. ${esc(p.confidence)})</span></li>`).join("")
      : "<li>Nenhuma praca ativa detectada nesta rota.</li>";
    el.className = "route-pricing-summary small " + (suggestion.manualPriceLocked ? "warn" : "ok");
    el.innerHTML = `
      <div><b>${esc(formatPricingSummary(pricingResult))}</b></div>
      <div>Distancia: <b>${esc(brNumber(suggestion.distanceKm))} km</b> · Tempo: <b>${esc(String(pricingResult.routeMetrics.durationMin || 0))} min</b> · Valor final do chamado: <b>${money(suggestion.finalValue || 0)}</b></div>
      <div>Pedagio calculado pela rota: <b>${money(toll.total || 0)}</b>. ${esc(toll.warning || "")}</div>
      <ul class="route-pricing-tolls">${plazas}</ul>`;
  }

  function syncRoutePricingToTowForm(pricingResult) {
    if (!pricingResult || !pricingResult.pricingSuggestion) return;
    const suggestion = pricingResult.pricingSuggestion;
    const toll = pricingResult.tollEstimate || {};
    if ($("callTowKm") && !parseMoney($("callTowKm").value || 0) && suggestion.distanceKm) {
      setValue("callTowKm", brNumber(suggestion.distanceKm));
      if ($("callTowActive")) $("callTowActive").checked = true;
    }
    if ($("callTowTollOneWay") && !parseMoney($("callTowTollOneWay").value || 0) && toll.oneWayTotal > 0) {
      setValue("callTowTollOneWay", brNumber(toll.oneWayTotal));
    }
    calculateTowPricing();
  }

  function calculateCurrentRoutePricing(options) {
    options = options || {};
    const route = bestRouteForPricing();
    if (!route) {
      if (options.render !== false) renderRoutePricingSummary(null);
      return null;
    }
    let towPricing = options.towPricing || calculateTowPricing();
    let callData = currentCallDataForPricing(towPricing);
    let result = calculateRoutePricing(callData, { route }, activePricingSettings(callData));
    if (options.syncTowForm) {
      syncRoutePricingToTowForm(result);
      towPricing = calculateTowPricing();
      callData = currentCallDataForPricing(towPricing);
      result = calculateRoutePricing(callData, { route }, activePricingSettings(callData));
    }
    state.routePricing = result;
    if (options.autoFill !== false && result.pricingSuggestion && !result.pricingSuggestion.manualPriceLocked && result.pricingSuggestion.suggestedServiceValue > 0) {
      setOfficialPriceField(result.pricingSuggestion.suggestedServiceValue, $("callPrice") && $("callPrice").value ? "suggested" : "auto");
    }
    if (options.render !== false) renderRoutePricingSummary(result);
    return result;
  }

  async function applyPricingToCall(callId, pricingResult, options) {
    const result = pricingResult || state.routePricing || calculateCurrentRoutePricing({ syncTowForm: true, autoFill: false });
    const suggestion = result && result.pricingSuggestion;
    if (!suggestion || !suggestion.suggestedServiceValue) {
      toast("Calcule a rota/preco antes de aplicar a sugestao.", "danger");
      return null;
    }
    if (!callId || options && options.updateForm) {
      setOfficialPriceField(suggestion.suggestedServiceValue, "suggested");
      state.routePricing = calculateCurrentRoutePricing({ syncTowForm: false, autoFill: false }) || result;
      setTowStatus("Preco sugerido aplicado conscientemente no valor previsto: " + money(suggestion.suggestedServiceValue) + ".", "ok");
      return suggestion.suggestedServiceValue;
    }
    const updates = {
      valor: suggestion.suggestedServiceValue,
      priceMode: "suggested",
      manualPriceLocked: false,
      pricingSuggestion: result.pricingSuggestion,
      tollEstimate: result.tollEstimate,
      updatedAt: new Date().toISOString(),
      timeline: arrayUnion({ at: new Date().toISOString(), by: personName(), text: "Preco sugerido pela rota aplicado ao chamado" })
    };
    await db.collection("calls").doc(callId).set(updates, { merge: true });
    if (canManageFinance()) await upsertCallReceivable(callId, { amount: suggestion.suggestedServiceValue, expectedAmount: suggestion.suggestedServiceValue, forceAmount: true, status: "A receber" });
    return suggestion.suggestedServiceValue;
  }

  function applySuggestedPriceToForm() {
    applyPricingToCall("", state.routePricing || calculateCurrentRoutePricing({ syncTowForm: true, autoFill: false }), { updateForm: true });
  }

  function setTowStatus(message, type) {
    const el = $("towPricingStatus");
    if (!el) return;
    el.textContent = message;
    el.className = "small " + (type || "muted");
  }

  function calculateTowPricing() {
    const active = !!($("callTowActive") && $("callTowActive").checked);
    const type = $("callTowType") ? $("callTowType").value : "leve";
    const defaults = towDefaults(type);
    const kmTotal = parseMoney($("callTowKm") && $("callTowKm").value || 0);
    const franchiseKm = parseMoney($("callTowFranchiseKm") && $("callTowFranchiseKm").value || 0) || 0;
    const baseOut = parseMoney($("callTowBaseOut") && $("callTowBaseOut").value || defaults.baseOut);
    const kmValue = parseMoney($("callTowKmValue") && $("callTowKmValue").value || defaults.kmValue);
    const discountPct = pct($("callTowDiscountPct") && $("callTowDiscountPct").value || 0);
    const roundTrip = $("callTowRoundTrip") ? !!$("callTowRoundTrip").checked : true;
    const subtractFranchise = $("callTowSubtractFranchise") ? !!$("callTowSubtractFranchise").checked : false;
    const tollOneWay = parseMoney($("callTowTollOneWay") && $("callTowTollOneWay").value || 0);
    const tollRoundTrip = $("callTowTollRoundTrip") ? !!$("callTowTollRoundTrip").checked : true;
    const legMultiplier = roundTrip ? 2 : 1;
    const chargedKm = active ? Math.max(kmTotal - (subtractFranchise ? franchiseKm : 0), 0) : 0;
    const chargedKmTotal = active ? round2(chargedKm * legMultiplier) : 0;
    const operationalKm = active ? round2(kmTotal * legMultiplier) : 0;
    const factor = Math.max(0, 1 - discountPct / 100);
    const netOut = active ? round2(baseOut * factor) : 0;
    const netKm = active ? trunc2(kmValue * factor) : 0;
    const oneWay = active ? round2(netOut + chargedKm * netKm) : 0;
    const tollTotal = active ? round2(tollOneWay * (tollRoundTrip && roundTrip ? 2 : 1)) : 0;
    const totalWithoutToll = active ? round2(oneWay * legMultiplier) : 0;
    const total = active ? round2(totalWithoutToll + tollTotal) : 0;
    const subtotalWithoutDiscount = active ? round2((baseOut + chargedKm * kmValue) * legMultiplier) : 0;
    const subtotal = active ? round2(subtotalWithoutDiscount + tollTotal) : 0;
    const discountValue = active ? round2(subtotalWithoutDiscount - totalWithoutToll) : 0;
    const data = {
      ativo: active,
      tipo: type,
      tipoLabel: defaults.label,
      kmTotal,
      kmIda: kmTotal,
      kmPorTrecho: kmTotal,
      kmOperacional: operationalKm,
      franquiaKm: franchiseKm,
      abaterFranquia: subtractFranchise,
      kmExcedente: chargedKm,
      kmCobrado: chargedKm,
      kmCobradoPorTrecho: chargedKm,
      kmCobradoTotal: chargedKmTotal,
      cobrarIdaVolta: roundTrip,
      idaVolta: roundTrip,
      multiplicadorTrecho: legMultiplier,
      valorSaida: baseOut,
      valorKmAdicional: kmValue,
      descontoPct: discountPct,
      descPct: discountPct,
      ajustePct: discountPct,
      saidaLiquida: netOut,
      kmLiquido: netKm,
      valorIda: oneWay,
      valorPorTrecho: oneWay,
      totalSemPedagio: totalWithoutToll,
      totalGuinchoSemPedagio: totalWithoutToll,
      valorPedagioIda: tollOneWay,
      pedagioIda: tollOneWay,
      cobrarPedagioIdaVolta: tollRoundTrip,
      pedagioIdaVolta: tollRoundTrip,
      pedagioTotal: tollTotal,
      valorPedagios: tollTotal,
      subtotal,
      subtotalSemDesconto: subtotalWithoutDiscount,
      descontoValor: discountValue,
      total,
      obs: $("callTowNotes") ? $("callTowNotes").value.trim() : ""
    };
    if ($("callTowNetOut")) $("callTowNetOut").value = money(netOut);
    if ($("callTowNetKm")) $("callTowNetKm").value = money(netKm);
    if ($("callTowOneWay")) $("callTowOneWay").value = money(oneWay);
    if ($("callTowTollTotal")) $("callTowTollTotal").value = money(tollTotal);
    if ($("callTowTotal")) $("callTowTotal").value = money(total);
    return data;
  }

  function setTowPricingForm(data) {
    const g = data || {};
    const type = g.tipo || "leve";
    const defaults = towDefaults(type);
    if ($("callTowActive")) $("callTowActive").checked = !!g.ativo;
    setValue("callTowType", type);
    setValue("callTowKm", g.kmTotal != null ? brNumber(g.kmTotal) : "");
    setValue("callTowFranchiseKm", g.franquiaKm != null ? brNumber(g.franquiaKm) : "15,00");
    setValue("callTowBaseOut", g.valorSaida != null ? brNumber(g.valorSaida) : brNumber(defaults.baseOut));
    setValue("callTowKmValue", g.valorKmAdicional != null ? brNumber(g.valorKmAdicional) : brNumber(defaults.kmValue));
    setValue("callTowDiscountPct", g.descontoPct ?? g.descPct ?? g.ajustePct ?? 0);
    if ($("callTowRoundTrip")) $("callTowRoundTrip").checked = g.cobrarIdaVolta ?? g.idaVolta ?? true;
    if ($("callTowSubtractFranchise")) $("callTowSubtractFranchise").checked = !!(g.abaterFranquia || g.usarFranquia || g.abaterKmFranquia);
    setValue("callTowTollOneWay", brNumber(g.valorPedagioIda ?? g.pedagioIda ?? 0));
    if ($("callTowTollRoundTrip")) $("callTowTollRoundTrip").checked = g.cobrarPedagioIdaVolta ?? g.pedagioIdaVolta ?? true;
    setValue("callTowNotes", g.obs || "");
    calculateTowPricing();
  }

  function updateTowDefaultsByType() {
    const type = $("callTowType") ? $("callTowType").value : "leve";
    const defaults = towDefaults(type);
    setValue("callTowBaseOut", brNumber(defaults.baseOut));
    setValue("callTowKmValue", brNumber(defaults.kmValue));
    calculateTowPricing();
  }

  function routeKmForTow() {
    const best = bestSmartRoute();
    const meters = best && best.serviceRoute && best.serviceRoute.distanceMeters
      || best && best.fullRoute && best.fullRoute.distanceMeters
      || best && best.toOrigin && best.toOrigin.distanceMeters
      || 0;
    if (meters) return Math.max(0, Math.round((meters / 1000) * 100) / 100);
    const points = routePointsFromForm(false);
    return routeKm(points);
  }

  function applyRouteKmToTowPricing() {
    const km = routeKmForTow();
    if (!km) return setTowStatus("Não há KM calculado. Primeiro busque origem/destino ou trace a rota inteligente.", "danger");
    setValue("callTowKm", brNumber(km));
    if ($("callTowActive")) $("callTowActive").checked = true;
    const data = calculateTowPricing();
    calculateCurrentRoutePricing({ syncTowForm: true, autoFill: false });
    setTowStatus("KM da rota aplicado: " + brNumber(km) + " km. Pedágios: " + money(data.pedagioTotal || 0) + ". Total atual: " + money(data.total) + ".", "ok");
  }

  function applyTowTotalToPrice() {
    const data = calculateTowPricing();
    if (!data.ativo) return setTowStatus("Marque Cobrar no chamado antes de aplicar o total.", "danger");
    setValue("callPrice", brNumber(data.total));
    setPriceMode("suggested", false);
    setTowStatus("Total do guincho aplicado no valor previsto: " + money(data.total) + ".", "ok");
  }


  async function getDocData(collectionName, id, localCache) {
    if (!id) return null;
    if (localCache && localCache[id]) return localCache[id];
    try {
      const snap = await db.collection(collectionName).doc(id).get();
      return snap.exists ? { id: snap.id, ...snap.data() } : null;
    } catch (err) {
      console.warn("Falha ao buscar", collectionName, id, err);
      return null;
    }
  }

  function callDisplayName(call) {
    if (!call) return "";
    return call.insurance || call.billingParty || call.cliente || call.customerName || call.protocolo || "";
  }

  function callProtocolLabel(call, fallbackId) {
    return call && (call.protocolo || call.insuranceProtocol || call.id) || fallbackId || "";
  }

  const REQUIRED_PROOF_PHOTOS = ["front", "rear", "right", "left", "dashboard", "load_after", "delivery_front", "delivery_rear", "delivery_right", "delivery_left", "delivery_dashboard", "damage", "final"];
  const REQUIRED_PROOF_STAGES = ["retirada", "carregamento", "transporte", "entrega", "finalizacao"];
  const PROOF_STAGE_LABELS = { retirada: "Retirada", carregamento: "Carregamento", transporte: "Transporte", entrega: "Entrega", finalizacao: "Finalização" };
  const PROOF_PHOTO_LABELS = {
    front: "Frente",
    rear: "Traseira",
    right: "Lateral direita",
    left: "Lateral esquerda",
    dashboard: "Painel / odômetro",
    load_after: "Carregado no caminhão",
    delivery_front: "Entrega - frente",
    delivery_rear: "Entrega - traseira",
    delivery_right: "Entrega - lateral direita",
    delivery_left: "Entrega - lateral esquerda",
    delivery_dashboard: "Entrega - painel / odômetro",
    damage: "Avarias",
    final: "Comprovante final"
  };

  function proofPhotos(call) {
    return Array.isArray(call && call.proofPhotos) ? call.proofPhotos.filter(Boolean) : [];
  }

  function requiredProofPhotoTypes(call) {
    const checklist = call && call.proofChecklist || {};
    const required = [];
    const add = (keys) => keys.forEach((key) => {
      if (REQUIRED_PROOF_PHOTOS.includes(key) && !required.includes(key)) required.push(key);
    });
    if (checklist.retirada && !["pendente", "justificado"].includes(checklist.retirada.status)) add(["front", "rear", "right", "left", "dashboard"]);
    if (checklist.carregamento && !["pendente", "justificado"].includes(checklist.carregamento.status)) add(["front", "rear", "right", "left", "dashboard", "load_after"]);
    if (checklist.entrega && !["pendente", "justificado"].includes(checklist.entrega.status)) add(["delivery_front", "delivery_rear", "delivery_right", "delivery_left", "delivery_dashboard", "final"]);
    const hasAvaria = Object.values(checklist || {}).some((item) => item && String(item.status || "").toLowerCase().includes("avaria"));
    if (hasAvaria) add(["damage"]);
    return required;
  }

  function callProofComplete(call) {
    const checklist = call && call.proofChecklist || {};
    const signature = call && call.customerSignature || {};
    const phaseSignatures = call && call.phaseSignatures || {};
    const hasChecklist = REQUIRED_PROOF_STAGES.every((stage) => checklist[stage] && checklist[stage].status && checklist[stage].status !== "pendente");
    const hasPhotos = requiredProofPhotoTypes(call).every((type) => proofPhotos(call).some((photo) => photo.type === type && photo.cloudinaryUrl));
    const hasPhaseAcceptances = ["retirada", "entrega", "finalizacao"].every((phase) => {
        const item = phaseSignatures[phase] || {};
        const row = checklist[phase] || {};
        const fallback = (phase === "entrega" || phase === "finalizacao") ? signature : {};
        return row.status !== "pendente" && (row.justificativa || ((item.signatureUrl || item.cloudinaryUrl) && item.acceptedText) || (item.refused && item.refusalReason && item.acceptedText) || ((fallback.signatureUrl || fallback.cloudinaryUrl) && fallback.acceptedText) || (fallback.refused && fallback.refusalReason && fallback.acceptedText));
      });
    return hasChecklist && hasPhotos && hasPhaseAcceptances;
  }

  function proofStatus(call) {
    if (call && call.proofStatus === "revisado") return "revisado";
    if (callProofComplete(call)) return "completo";
    if (call && (proofPhotos(call).length || call.proofChecklist || call.customerSignature)) return "parcial";
    return "pendente";
  }

  function proofStatusBadge(call) {
    const status = proofStatus(call);
    const cls = status === "revisado" || status === "completo" ? "ok" : status === "parcial" ? "warn" : "danger";
    return `<span class="badge ${cls}">Provas: ${esc(status)}</span>`;
  }

  function proofPhotoLabel(type) {
    return PROOF_PHOTO_LABELS[type] || type || "Foto";
  }

  function proofPhotoByType(photos, type) {
    return (photos || []).find((photo) => photo && photo.type === type && photo.cloudinaryUrl) || null;
  }

  function enrichFinancialPayloadFromCall(payload, call) {
    const out = Object.assign({}, payload || {});
    if (!call) return out;
    out.callId = out.callId || call.id || "";
    out.vehicleId = out.vehicleId || call.vehicleId || "";
    out.driverId = out.driverId || call.driverId || "";
    out.customerId = out.customerId || call.customerId || "";
    out.billingParty = out.billingParty || callDisplayName(call);
    out.customerName = out.customerName || call.cliente || call.customerName || "";
    out.insurance = out.insurance || call.insurance || "";
    out.insuranceProtocol = out.insuranceProtocol || call.insuranceProtocol || "";
    out.protocol = out.protocol || callProtocolLabel(call, call.id);
    out.customerPlate = out.customerPlate || call.customerPlate || "";
    out.serviceType = out.serviceType || call.serviceType || "";
    return out;
  }

  async function recalculateCallFinancials(callId) {
    if (!callId || !canManageFinance()) return;
    const call = await getDocData("calls", callId, state.calls);
    if (!call) return;
    const snap = await db.collection("transactions").where("callId", "==", callId).get();
    const rows = [];
    snap.forEach((doc) => {
      const data = { id: doc.id, ...doc.data() };
      if (!data.deletedAt) rows.push(data);
    });
    const entradas = rows.filter((t) => t.type === "entrada");
    const saidas = rows.filter((t) => t.type === "saida");
    const expectedFromReceivable = entradas
      .filter((t) => t.module === "call_receivable" || t.sourceType === "call_receivable" || t.sourceType === "call")
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const expectedAmount = Math.max(Number(call.valor || 0), expectedFromReceivable);
    const paidAmount = entradas.reduce((sum, t) => {
      if (statusMeansReceived(t.status)) return sum + Number(t.paidAmount || t.receivedAmount || t.amount || 0);
      return sum + Number(t.paidAmount || t.receivedAmount || 0);
    }, 0);
    const costAmount = saidas.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const balanceAmount = Math.max(0, expectedAmount - paidAmount);
    let billingStatus = call.billingStatus || "aberto";
    if (expectedAmount > 0) {
      billingStatus = paidAmount <= 0 ? "a_receber" : balanceAmount > 0.009 ? "parcial" : "recebido";
    } else if (isFinalStatus(call.statusKey || call.status)) {
      billingStatus = "sem_valor";
    }
    await db.collection("calls").doc(callId).set({
      financialSummary: {
        expectedAmount,
        paidAmount,
        costAmount,
        balanceAmount,
        profitAmount: expectedAmount - costAmount,
        marginPercent: expectedAmount > 0 ? Math.round(((expectedAmount - costAmount) / expectedAmount) * 10000) / 100 : 0,
        transactionsCount: rows.length,
        recalculatedAt: new Date().toISOString()
      },
      billingStatus,
      paidAmount,
      balanceAmount,
      costAmount,
      updatedFinancialAt: new Date().toISOString()
    }, { merge: true });
  }

  async function upsertCallReceivable(callId, options) {
    if (!callId || !canManageFinance()) return null;
    const call = await getDocData("calls", callId, state.calls);
    if (!call) {
      toast("Chamado vinculado ao recebimento não foi encontrado.", "danger");
      return null;
    }
    const now = new Date().toISOString();
    const txId = sourceDocId("call_receivable", callId);
    const optionAmount = Number(options && (options.expectedAmount ?? options.amount) || 0);
    const expectedAmount = options && options.forceAmount ? optionAmount : Math.max(Number(call.valor || 0), optionAmount);
    const paidAmount = statusMeansReceived(options && options.status) ? Number(options && options.paidAmount != null ? options.paidAmount : options && options.amount || expectedAmount) : Number(options && options.paidAmount || 0);
    const balanceAmount = Math.max(0, expectedAmount - paidAmount);
    const status = options && options.status || (paidAmount <= 0 ? "A receber" : balanceAmount > 0.009 ? "Parcial" : "Recebido");
    const base = enrichFinancialPayloadFromCall({
      module: "call_receivable",
      sourceType: "call_receivable",
      sourceId: callId,
      type: "entrada",
      date: options && options.date || todayInput(),
      dueDate: options && options.dueDate || options && options.date || todayInput(),
      description: options && options.description || `Chamado ${callProtocolLabel(call, callId)} - ${callDisplayName(call)}`,
      category: options && options.category || "Receita de chamado",
      amount: expectedAmount,
      paidAmount,
      balanceAmount,
      status,
      paymentMethod: options && options.paymentMethod || "",
      invoiceNumber: options && options.invoiceNumber || "",
      updatedAt: now,
      updatedBy: state.user.uid
    }, call);
    const ref = db.collection("transactions").doc(txId);
    const old = await ref.get();
    await ref.set(Object.assign(old.exists ? {} : { createdAt: now, createdBy: state.user.uid }, base), { merge: true });
    await db.collection("calls").doc(callId).set({
      financeCreated: true,
      receivableTransactionId: txId,
      billingStatus: statusLower(status).replace(/\s+/g, "_"),
      paidAmount,
      balanceAmount,
      updatedFinancialAt: now,
      timeline: arrayUnion({ at: now, by: personName(), text: "Financeiro do chamado atualizado automaticamente" })
    }, { merge: true });
    await recalculateCallFinancials(callId);
    return txId;
  }

  async function upsertTransactionFromExpense(expenseId, expenseData) {
    if (!expenseId || !expenseData || !canManageFinance()) return null;
    const now = new Date().toISOString();
    const call = await getDocData("calls", expenseData.callId, state.calls);
    const linked = enrichFinancialPayloadFromCall(expenseData, call);
    const vehicleId = linked.vehicleId || expenseData.vehicleId || "";
    const driverId = linked.driverId || expenseData.driverId || "";
    const amount = Number(expenseData.amount || 0);
    const txId = sourceDocId("expense", expenseId);
    const txRef = db.collection("transactions").doc(txId);
    const txSnap = await txRef.get();
    await txRef.set(Object.assign(txSnap.exists ? {} : { createdAt: now, createdBy: state.user.uid }, {
      module: "driver_expense",
      sourceType: "driver_expense",
      sourceId: expenseId,
      expenseId,
      type: "saida",
      date: todayInput(),
      description: `Despesa ${expenseData.type || ""}${expenseData.driverName ? " - " + expenseData.driverName : ""}${linked.protocol ? " · " + linked.protocol : ""}`,
      category: expenseData.type || "Despesa motorista",
      amount,
      status: "Pendente",
      callId: linked.callId || "",
      vehicleId,
      driverId,
      costCenter: vehicleId ? "Frota" : "Operação",
      vehicleCost: !!vehicleId,
      vehicleCostKind: vehicleCostKind(expenseData.type, expenseData.notes),
      vehicleCostCategory: expenseData.type || "Despesa motorista",
      approvalStatus: "approved",
      customerId: linked.customerId || "",
      billingParty: linked.billingParty || "",
      insurance: linked.insurance || "",
      insuranceProtocol: linked.insuranceProtocol || "",
      protocol: linked.protocol || "",
      photoUrl: expenseData.photoUrl || "",
      notes: expenseData.notes || "",
      updatedAt: now,
      updatedBy: state.user.uid
    }), { merge: true });

    await db.collection("expenses").doc(expenseId).set({
      status: "aprovado",
      approvedAt: now,
      approvedBy: state.user.uid,
      financialTransactionId: txId,
      linkedCallId: linked.callId || "",
      linkedVehicleId: vehicleId,
      linkedDriverId: driverId,
      vehicleCostRecorded: !!vehicleId,
      vehicleCostKind: vehicleCostKind(expenseData.type, expenseData.notes),
      vehicleCostCategory: expenseData.type || "Despesa motorista",
      customerId: linked.customerId || "",
      billingParty: linked.billingParty || "",
      protocol: linked.protocol || "",
      updatedAt: now,
      updatedBy: state.user.uid
    }, { merge: true });

    if (linked.callId) {
      await db.collection("calls").doc(linked.callId).set({
        costAmount: (Number(call && call.costAmount || 0) + 0),
        timeline: arrayUnion({ at: now, by: personName(), text: `Despesa aprovada e vinculada ao financeiro: ${money(amount)}` }),
        updatedFinancialAt: now
      }, { merge: true });
      await recalculateCallFinancials(linked.callId);
    }

    if (canManageFleet() && vehicleId && isMaintenanceExpenseType(expenseData.type, expenseData.notes)) {
      const maintId = sourceDocId("expense", expenseId);
      await db.collection("maintenance").doc(maintId).set({
        sourceType: "driver_expense",
        sourceExpenseId: expenseId,
        financialTransactionId: txId,
        vehicleId,
        date: todayInput(),
        description: expenseData.notes || `Despesa de ${expenseData.type || "manutenção"}`,
        odometerKm: expenseData.odometerKm || "",
        cost: amount,
        status: "concluida",
        createdAt: now,
        createdBy: state.user.uid,
        updatedAt: now,
        updatedBy: state.user.uid
      }, { merge: true });
    }
    return txId;
  }

  async function upsertTransactionFromMaintenance(maintenanceId, maintenanceData) {
    if (!maintenanceId || !maintenanceData || !canManageFinance()) return null;
    if (maintenanceData.sourceExpenseId) return maintenanceData.financialTransactionId || sourceDocId("expense", maintenanceData.sourceExpenseId);
    const amount = Number(maintenanceData.cost || 0);
    const txId = sourceDocId("maintenance", maintenanceId);
    if (amount <= 0) return null;
    const now = new Date().toISOString();
    const vehicle = await getDocData("vehicles", maintenanceData.vehicleId, state.vehicles);
    const ref = db.collection("transactions").doc(txId);
    const old = await ref.get();
    await ref.set(Object.assign(old.exists ? {} : { createdAt: now, createdBy: state.user.uid }, {
      module: "maintenance",
      sourceType: "maintenance",
      sourceId: maintenanceId,
      maintenanceId,
      type: "saida",
      date: maintenanceData.date || todayInput(),
      description: `Manutenção ${vehicle && vehicle.placa || maintenanceData.vehicleId || ""} - ${maintenanceData.description || ""}`,
      category: "Manutenção de frota",
      amount,
      status: maintenanceData.status === "concluida" ? "Pago" : "Pendente",
      vehicleId: maintenanceData.vehicleId || "",
      costCenter: maintenanceData.vehicleId ? "Frota" : "Operação",
      vehicleCost: !!maintenanceData.vehicleId,
      vehicleCostKind: "maintenance",
      vehicleCostCategory: "Manutenção de frota",
      odometerKm: maintenanceData.odometerKm || "",
      updatedAt: now,
      updatedBy: state.user.uid
    }), { merge: true });
    await db.collection("maintenance").doc(maintenanceId).set({ financialTransactionId: txId, updatedFinancialAt: now }, { merge: true });
    return txId;
  }

  function currentStatusKey(call) {
    return operationalKey(call && (call.statusKey || call.status));
  }

  function slaInfo(call) {
    if (!call || !call.slaLimitAt) return { label: "Sem SLA", className: "muted", overdue: false };
    const limit = new Date(call.slaLimitAt);
    if (Number.isNaN(limit.getTime())) return { label: "SLA inválido", className: "warn", overdue: false };
    const diff = limit.getTime() - Date.now();
    if (isFinalStatus(call.statusKey || call.status)) return { label: "SLA encerrado", className: "ok", overdue: false };
    if (diff < 0) return { label: "SLA vencido", className: "danger", overdue: true };
    const minutes = Math.ceil(diff / 60000);
    if (minutes <= 30) return { label: "SLA em " + minutes + " min", className: "warn", overdue: false };
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return { label: "SLA em " + (hours ? hours + "h " : "") + rest + "min", className: "ok", overdue: false };
  }

  function setButtonBusy(button, busy, text) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.disabled = true;
      button.textContent = text || "Aguarde...";
    } else {
      button.disabled = false;
      if (button.dataset.originalText) button.textContent = button.dataset.originalText;
    }
  }

  function addressStatus(id, message, type) {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.className = "small geo-status " + (type || "muted");
  }

  function setAddress(kind, address) {
    const isOrigin = kind === "origin";
    const labelId = isOrigin ? "callOriginLabel" : "callDestLabel";
    const latId = isOrigin ? "callOriginLat" : "callDestLat";
    const lngId = isOrigin ? "callOriginLng" : "callDestLng";
    const statusId = isOrigin ? "originGeoStatus" : "destGeoStatus";
    const point = usefulPoint(address && (address.coords || address));
    const normalized = {
      label: address && address.label || $(labelId).value.trim(),
      coords: point,
      placeId: address && address.placeId || "",
      source: address && address.source || "manual",
      resolvedAt: address && address.resolvedAt || new Date().toISOString()
    };
    state.addresses[kind] = normalized;
    if (normalized.label) $(labelId).value = normalized.label;
    if (point) {
      $(latId).value = String(point.lat);
      $(lngId).value = String(point.lng);
      addressStatus(statusId, "Endereço validado: " + normalized.label + " (" + point.lat.toFixed(6) + ", " + point.lng.toFixed(6) + ")", "ok");
    } else {
      addressStatus(statusId, "Endereço ainda sem coordenadas. Cole link do mapa com coordenadas ou informe latitude/longitude.", "danger");
    }
    state.smartRoute = null;
    renderSmartRouteBox();
    return normalized;
  }

  function routeLinkStatus(message, type) {
    const el = $("routeLinkStatus");
    if (!el) return;
    el.textContent = message;
    el.className = "small route-link-status " + (type || "muted");
  }

  function currentExternalRouteUrl() {
    const input = $("callRouteExternalUrl");
    return normalizeUrl(input && input.value || "");
  }

  function routePointsFromForm(includeVehicle) {
    const points = [];
    const selectedVehicle = includeVehicle ? state.vehicles[$("callVehicle") && $("callVehicle").value] || null : null;
    const origin = addressFromInputs("origin");
    const destination = addressFromInputs("destination");
    if (selectedVehicle && usefulPoint(selectedVehicle.location)) points.push(usefulPoint(selectedVehicle.location));
    if (origin && usefulPoint(origin.coords)) points.push(usefulPoint(origin.coords));
    (state.addresses.waypoints || []).forEach((wp) => { if (wp && usefulPoint(wp.coords)) points.push(usefulPoint(wp.coords)); });
    if (destination && usefulPoint(destination.coords)) points.push(usefulPoint(destination.coords));
    return points;
  }

  function userIdByEmail(rawEmail) {
    const email = String(rawEmail || "").toLowerCase().trim();
    if (!email) return "";
    const row = Object.values(state.users || {}).find((u) => String(u.email || "").toLowerCase().trim() === email);
    return row && row.id || "";
  }

  function driverIdFromVehicle(vehicle) {
    const v = vehicle || {};
    const direct = v.driverId || v.activeDriverId || v.driverUid || v.motoristaId || v.assignedDriverId || "";
    if (direct && state.users[direct]) return direct;
    if (direct && !String(direct).includes("@")) return direct;
    return userIdByEmail(direct || v.driverEmail || v.activeDriverEmail || v.motoristaEmail || v.assignedDriverEmail);
  }

  function selectedDriverIdForCall() {
    const explicit = $("callDriver") && $("callDriver").value || "";
    if (explicit) return explicit;
    const vehicle = state.vehicles[$("callVehicle") && $("callVehicle").value] || null;
    const resolved = driverIdFromVehicle(vehicle);
    if (resolved && $("callDriver")) setValue("callDriver", resolved);
    return resolved || "";
  }

  function addressFromInputs(kind) {
    const isOrigin = kind === "origin";
    const label = $(isOrigin ? "callOriginLabel" : "callDestLabel").value.trim();
    const point = usefulPoint(coords($(isOrigin ? "callOriginLat" : "callDestLat").value, $(isOrigin ? "callOriginLng" : "callDestLng").value));
    const existing = state.addresses[kind] || {};
    if (!label && !point) return null;
    return {
      label: label || existing.label || "",
      coords: point || existing.coords || null,
      placeId: existing.placeId || "",
      source: existing.source || (point ? "manual_coords" : "manual_text"),
      resolvedAt: existing.resolvedAt || new Date().toISOString()
    };
  }

  function initializeAddressTools() {
    const gm = window.JM.googleMaps;
    if (!gm) return;
    const settings = activeMapSettings();
    if (false) {
      addressStatus("originGeoStatus", "Modo gratuito ativo: cole link compartilhado do mapa ou coordenadas. Não usa API paga.", "warn");
      return;
    }
    if ($("callOriginLabel") && !$("callOriginLabel").dataset.addressToolsReady) {
      $("callOriginLabel").dataset.addressToolsReady = "1";
      gm.initAutocomplete("callOriginLabel", (addr) => setAddress("origin", addr), settings).catch((err) => addressStatus("originGeoStatus", err.message, "danger"));
    }
    if ($("callDestLabel") && !$("callDestLabel").dataset.addressToolsReady) {
      $("callDestLabel").dataset.addressToolsReady = "1";
      gm.initAutocomplete("callDestLabel", (addr) => setAddress("destination", addr), settings).catch((err) => addressStatus("destGeoStatus", err.message, "danger"));
    }
    const googleReady = gm.isGoogleConfigured ? gm.isGoogleConfigured(settings) : gm.isConfigured(settings);
    if (googleReady) {
      addressStatus("originGeoStatus", "Google Maps ativo: digite o endereco, selecione a sugestao ou clique em buscar.", "ok");
      addressStatus("destGeoStatus", "Google Maps ativo para destino. Se nao aparecer sugestao, clique em buscar.", "ok");
    } else {
      addressStatus("originGeoStatus", "Modo gratuito ativo: digite endereco com cidade/UF, cole link do Maps/Waze ou use coordenadas.", "warn");
      addressStatus("destGeoStatus", "Modo gratuito ativo: digite destino com cidade/UF, cole link do Maps/Waze ou use coordenadas.", "warn");
    }
  }

  async function geocodeAddress(kind) {
    const gm = window.JM.googleMaps;
    const isOrigin = kind === "origin";
    const labelId = isOrigin ? "callOriginLabel" : "callDestLabel";
    const statusId = isOrigin ? "originGeoStatus" : "destGeoStatus";
    const value = $(labelId).value.trim();
    try {
      if (!gm) throw new Error("Busca de mapa indisponivel nesta tela.");
      if (!value) throw new Error("Digite um endereco com cidade/UF, cole um link do mapa ou informe coordenadas.");
      addressStatus(statusId, "Buscando endereco e coordenadas...", "muted");
      const addr = await gm.geocode(value, activeMapSettings());
      setAddress(kind, addr);
      toast((isOrigin ? "Origem" : "Destino") + " validado com coordenadas.", "ok");
    } catch (err) {
      addressStatus(statusId, err.message, "danger");
      toast(err.message, "danger");
    }
  }

  function openAddressInGoogle(kind) {
    const isOrigin = kind === "origin";
    const labelId = isOrigin ? "callOriginLabel" : "callDestLabel";
    const latId = isOrigin ? "callOriginLat" : "callDestLat";
    const lngId = isOrigin ? "callOriginLng" : "callDestLng";
    const point = coords($(latId).value, $(lngId).value);
    const text = point ? point.lat + "," + point.lng : ($(labelId).value.trim() || "");
    if (!text) return toast("Digite o endereco antes de abrir no Google Maps.", "danger");
    const url = window.JM.googleMaps && window.JM.googleMaps.googlePlaceUrl ? window.JM.googleMaps.googlePlaceUrl(text) : "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(text);
    window.open(url, "_blank", "noopener");
  }

  function useCurrentLocationAsOrigin() {
    if (!navigator.geolocation) return toast("Este navegador não liberou geolocalização.", "danger");
    addressStatus("originGeoStatus", "Capturando localização do aparelho...", "muted");
    navigator.geolocation.getCurrentPosition((pos) => {
      setAddress("origin", {
        label: "Localização atual do aparelho",
        coords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
        source: "browser_geolocation",
        resolvedAt: new Date().toISOString()
      });
      toast("Localização atual aplicada como origem.", "ok");
    }, (err) => {
      addressStatus("originGeoStatus", "Não foi possível obter localização: " + err.message, "danger");
    }, { enableHighAccuracy: true, timeout: 12000 });
  }

  function bestSmartRoute() {
    return state.smartRoute && state.smartRoute.rankings && state.smartRoute.rankings[0] || null;
  }

  function renderSmartRouteBox() {
    const box = $("smartRouteBox");
    if (!box) return;
    const route = state.smartRoute;
    if (!route || !route.rankings || !route.rankings.length) {
      box.innerHTML = "Informe a origem e clique em <b>Traçar rota inteligente</b>. O algoritmo usa posição do tracker, status do veículo, distância e tempo estimado.";
      return;
    }
    box.innerHTML = route.rankings.slice(0, 5).map((r, i) => {
      const v = r.vehicle || {};
      const badge = i === 0 ? '<span class="badge ok">RECOMENDADO</span>' : '<span class="badge info">Opção ' + (i + 1) + '</span>';
      const src = r.toOrigin && r.toOrigin.source === "osrm_openstreetmap" ? "rota por ruas" : "fallback estimado";
      return `<div class="smart-route-card">
        <div>${badge} <b>${esc(v.placa || v.id || "Veículo")}</b> <span class="muted">${esc(v.apelido || v.tipo || "")}</span></div>
        <div>Até a origem: <b>${esc(r.toOrigin.distanceText || r.kmToOrigin.toFixed(1) + " km")}</b> · <b>${esc(r.toOrigin.durationTrafficText || r.toOrigin.durationText || r.minutesToOrigin + " min")}</b> · fonte: ${esc(src)}</div>
        ${r.serviceRoute ? `<div>Origem ? destino: <b>${esc(r.serviceRoute.distanceText || "")}</b> · <b>${esc(r.serviceRoute.durationTrafficText || r.serviceRoute.durationText || "")}</b></div>` : ""}
        <div class="actions"><button class="btn primary" type="button" onclick="JM.app.applySmartVehicle('${esc(v.id)}')">Usar este veículo</button>${r.routeUrl ? `<a class="btn" target="_blank" rel="noopener noreferrer" href="${esc(r.routeUrl)}">Abrir rota</a>` : ""}</div>
      </div>`;
    }).join("");
  }

  async function calculateSmartRoute() {
    const gm = window.JM.googleMaps;
    const origin = addressFromInputs("origin");
    let destination = addressFromInputs("destination");
    if (!origin || !origin.coords) {
      if (origin && origin.label && gm && gm.isConfigured(activeMapSettings())) {
        await geocodeAddress("origin");
      }
    }
    const finalOrigin = addressFromInputs("origin");
    if (!finalOrigin || !finalOrigin.coords) return toast("Informe a origem por link do mapa ou latitude/longitude antes da rota inteligente.", "danger");
    if (destination && destination.label && !destination.coords && gm && gm.isConfigured(activeMapSettings())) {
      await geocodeAddress("destination");
      destination = addressFromInputs("destination");
    }
    const fleetForRoute = appendMobileGpsSideMarkers(Object.fromEntries(Object.values(state.vehicles || {}).map(vehicleWithLiveGps).map((v) => [v.id, v])));
    const located = Object.values(fleetForRoute).filter((v) => vehicleLivePoint(v));
    if (!located.length) return toast(isMobileGpsEnabled() ? "Nenhum veículo tem posição de tracker/celular. Sincronize o tracker ou ative o GPS do motorista no painel do motorista." : "Nenhum veículo tem posição de tracker. Sincronize o tracker no painel gestor/superadmin.", "danger");
    $("smartRouteBox").innerHTML = "Calculando melhor veículo e tempo de rota...";
    try {
      const rankings = await gm.rankVehicles(fleetForRoute, finalOrigin.coords, destination && destination.coords, activeMapSettings());
      state.smartRoute = { origin: finalOrigin, destination, rankings, calculatedAt: new Date().toISOString() };
      const best = bestSmartRoute();
      if (best && !$("callVehicle").value) $("callVehicle").value = best.vehicle.id;
      if (best) calculateCurrentRoutePricing({ syncTowForm: true, autoFill: true });
      renderSmartRouteBox();
      toast("Rota inteligente calculada por ruas/rodovias quando disponível.", "ok");
    } catch (err) {
      $("smartRouteBox").innerHTML = `<span class="danger">${esc(err.message)}</span>`;
      toast(err.message, "danger");
    }
  }

  function applySmartVehicle(vehicleId) {
    if ($("callVehicle")) $("callVehicle").value = vehicleId || "";
    const driverId = driverIdFromVehicle(state.vehicles[vehicleId] || null);
    if (driverId && $("callDriver")) setValue("callDriver", driverId);
    toast("Veículo aplicado ao chamado.", "ok");
  }

  async function readSharedRouteLink() {
    const gm = window.JM.googleMaps;
    const input = $("callRouteExternalUrl");
    if (!input) return;
    const raw = input.value.trim();
    if (!raw) return routeLinkStatus("Cole um link de rota do Maps/Waze ou uma URL com coordenadas.", "danger");
    const parsed = gm && gm.parseRouteInput ? gm.parseRouteInput(raw) : { externalUrl: normalizeUrl(raw), points: [] };
    if (parsed.externalUrl) input.value = parsed.externalUrl;
    if (!parsed.points || !parsed.points.length) {
      routeLinkStatus("Link salvo para abrir fora do sistema. Ele não trouxe coordenadas visíveis; mantenha origem/destino preenchidos para desenhar a rota no mapa interno.", "warn");
      return;
    }
    if (parsed.points.length === 1) {
      setAddress("destination", {
        label: "Ponto do link compartilhado",
        coords: parsed.points[0],
        source: parsed.source,
        provider: parsed.provider,
        externalUrl: parsed.externalUrl,
        resolvedAt: parsed.resolvedAt
      });
      routeLinkStatus("Link lido com 1 coordenada. Usei como destino. Se for origem, ajuste no campo correto.", "ok");
      return;
    }
    setAddress("origin", {
      label: "Origem do link compartilhado",
      coords: parsed.points[0],
      source: parsed.source,
      provider: parsed.provider,
      externalUrl: parsed.externalUrl,
      resolvedAt: parsed.resolvedAt
    });
    const last = parsed.points[parsed.points.length - 1];
    setAddress("destination", {
      label: "Destino do link compartilhado",
      coords: last,
      source: parsed.source,
      provider: parsed.provider,
      externalUrl: parsed.externalUrl,
      resolvedAt: parsed.resolvedAt
    });
    state.addresses.waypoints = parsed.points.slice(1, -1).map((point, index) => ({
      label: "Parada " + (index + 1) + " do link compartilhado",
      coords: point,
      source: parsed.source,
      provider: parsed.provider,
      resolvedAt: parsed.resolvedAt
    }));
    routeLinkStatus("Link de rota lido com " + parsed.points.length + " ponto(s). O mapa interno vai desenhar por ruas quando disponível.", "ok");
    await calculateSmartRoute();
  }

  function openGoogleRouteFromForm() {
    const external = currentExternalRouteUrl();
    const points = routePointsFromForm(true);
    const url = external || (window.JM.googleMaps && window.JM.googleMaps.routeUrl(points) || mapsRouteUrl(points));
    if (!url) return toast("Informe origem/destino e selecione veículo com posição para abrir a rota.", "danger");
    window.open(url, "_blank");
  }

  function showView(name) {
    $all(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
    $all("#navButtons button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    const titles = {
      dashboard: "Dashboard",
      operacao: "Central Operacional",
      chamados: "Chamados",
      finalizados: "Finalizados",
      clientes: "Clientes / seguradoras",
      integracoes: "Integrações",
      assistente: "Assistente IA",
      mapa: "Mapa / Tracker",
      motorista: "Painel motorista",
      financeiro: "Financeiro",
      pagamentos: "Pagamentos",
      frota: "Frota",
      equipe: "Equipe"
    };
    $("pageTitle").textContent = titles[name] || name;
    document.body.classList.remove("menu-open");
    refreshMaps();
  }

  function applySidebarState(collapsed) {
    state.sidebarCollapsed = !!collapsed;
    document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
    const btn = $("sidebarToggle");
    if (btn) {
      btn.setAttribute("aria-pressed", state.sidebarCollapsed ? "true" : "false");
      btn.setAttribute("aria-label", state.sidebarCollapsed ? "Expandir menu" : "Recolher menu");
      btn.title = state.sidebarCollapsed ? "Expandir menu" : "Recolher menu";
    }
    writeLocal("jm.sidebar.collapsed", state.sidebarCollapsed ? "true" : "false");
    setTimeout(() => window.JM.mapa && window.JM.mapa.invalidateAll && window.JM.mapa.invalidateAll(), 180);
  }

  function syncMapProviderControls() {
    $all(".mapProviderSelect").forEach((select) => {
      select.value = state.mapProvider || "google_road";
    });
  }

  function setMapProvider(provider) {
    state.mapProvider = provider || "google_road";
    writeLocal("jm.map.provider", state.mapProvider);
    syncMapProviderControls();
    window.JM_MAP_SETTINGS = activeMapSettings();
    if (window.JM.mapa && typeof window.JM.mapa.setMapProvider === "function") {
      window.JM.mapa.setMapProvider(state.mapProvider);
    }
    refreshMaps();
  }

  function bindSidebarAndMapControls() {
    if ($("sidebarToggle")) $("sidebarToggle").onclick = () => applySidebarState(!state.sidebarCollapsed);
    applySidebarState(state.sidebarCollapsed);
    syncMapProviderControls();
    $all(".mapProviderSelect").forEach((select) => {
      select.onchange = (e) => setMapProvider(e.target.value);
    });
  }

  function bindNavigation() {
    $all("#navButtons button").forEach((btn) => {
      btn.onclick = () => showView(btn.dataset.view);
    });
    $("menuBtn").onclick = () => document.body.classList.toggle("menu-open");
    if ($("opsStatusFilter")) $("opsStatusFilter").onchange = (e) => { state.operationFilter = e.target.value || "ativos"; renderOperations(); refreshMaps(); };
    ["Priority", "Insurance", "Driver", "Vehicle"].forEach((name) => {
      const id = "ops" + name + "Filter";
      const key = "operation" + name + "Filter";
      if ($(id)) $(id).onchange = (e) => { state[key] = e.target.value || ""; renderOperations(); refreshMaps(); };
    });
    if ($("btnOpsRefreshTracker")) $("btnOpsRefreshTracker").onclick = () => syncTrackerNow(true);
    if ($("btnOpsNewCall")) $("btnOpsNewCall").onclick = () => showView("chamados");
    if ($("btnOpsAssignVehicle")) $("btnOpsAssignVehicle").onclick = assignSelectedVehicleToSelectedCall;
    if ($("btnOpsOpenRoute")) $("btnOpsOpenRoute").onclick = openSelectedCallRoute;
    if ($("btnOpsCopyRoute")) $("btnOpsCopyRoute").onclick = copySelectedCallRoute;
    $("logoutBtn").onclick = () => auth.signOut();
  }

  function setSubmitText(formId, text) {
    const button = document.querySelector(`#${formId} button[type="submit"]`);
    if (button) button.textContent = text;
  }

  function setValue(id, value) {
    const el = $(id);
    if (el) el.value = value == null ? "" : String(value);
  }

  function resetCallForm() {
    if ($("callForm")) $("callForm").reset();
    state.editingCallId = null;
    state.pendingIntegrationId = null;
    state.addresses = { origin: null, destination: null, waypoints: [] };
    state.smartRoute = null;
    state.routePricing = null;
    setPriceMode("", false);
    setSubmitText("callForm", "Registrar chamado");
    if ($("callCancelEdit")) $("callCancelEdit").classList.add("hidden");
    renderSmartRouteBox();
    addressStatus("originGeoStatus", "Aguardando link do mapa ou coordenadas.", "muted");
    addressStatus("destGeoStatus", "Destino opcional; pode ser link compartilhado ou coordenadas.", "muted");
    routeLinkStatus("Opcional: cole o link compartilhado da rota para abrir no Maps/Waze e, se ele trouxer coordenadas visíveis, preencher origem/destino.", "muted");
    renderRoutePricingSummary(null);
    if ($("callRouteExternalUrl")) $("callRouteExternalUrl").value = "";
    setTowPricingForm({ ativo: false, tipo: "leve", franquiaKm: 15, cobrarIdaVolta: true });
    setTowStatus("Ao traçar rota inteligente, o sistema pode sugerir o KM automaticamente. O gestor pode editar tudo antes de salvar.", "muted");
  }

  function resetTeamForm() {
    if ($("teamForm")) $("teamForm").reset();
    state.editingUserId = null;
    if ($("teamEmail")) $("teamEmail").readOnly = false;
    if ($("teamPass")) $("teamPass").placeholder = "mínimo 6 caracteres";
    setSubmitText("teamForm", "Criar/atualizar equipe");
    if ($("teamCancelEdit")) $("teamCancelEdit").classList.add("hidden");
  }

  function resetFinanceForm() {
    if ($("financeForm")) $("financeForm").reset();
    state.editingTransactionId = null;
    setSubmitText("financeForm", "Salvar financeiro");
    if ($("financeCancelEdit")) $("financeCancelEdit").classList.add("hidden");
    if ($("finDate")) $("finDate").value = todayInput();
  }

  function resetPaymentForm() {
    if ($("paymentForm")) $("paymentForm").reset();
    state.editingPaymentId = null;
    setSubmitText("paymentForm", "Salvar pagamento");
    if ($("paymentCancelEdit")) $("paymentCancelEdit").classList.add("hidden");
    if ($("payDate")) $("payDate").value = todayInput();
  }

  function resetCustomerForm() {
    if ($("customerForm")) $("customerForm").reset();
    state.editingCustomerId = null;
    setSubmitText("customerForm", "Salvar cliente");
    if ($("customerCancelEdit")) $("customerCancelEdit").classList.add("hidden");
  }

  function resetMaintenanceForm() {
    if ($("maintenanceForm")) $("maintenanceForm").reset();
    state.editingMaintenanceId = null;
    setSubmitText("maintenanceForm", "Salvar manutenção");
    if ($("maintenanceCancelEdit")) $("maintenanceCancelEdit").classList.add("hidden");
    if ($("maintenanceDate")) $("maintenanceDate").value = todayInput();
  }

  function bindInputMasks() {
    const phone = $("callPhone");
    if (phone) phone.oninput = () => { phone.value = maskPhone(phone.value); };
    ["callCustomerPlate", "vehiclePlate"].forEach((id) => {
      const el = $(id);
      if (el) el.oninput = () => { el.value = plateKey(el.value); };
    });
    ["callPrice", "callExtraKm", "finAmount", "maintenanceCost", "payAmount"].forEach((id) => {
      const el = $(id);
      if (id === "callPrice" && el) el.oninput = () => {
        setPriceMode("manual", true);
        if (state.routePricing) calculateCurrentRoutePricing({ syncTowForm: false, autoFill: false });
      };
      if (el) el.onblur = () => { if (el.value) el.value = String(parseMoney(el.value)).replace(".", ","); };
    });
    ["customerPhone", "customerBillingPhone"].forEach((id) => {
      const el = $(id);
      if (el) el.oninput = () => { el.value = maskPhone(el.value); };
    });
  }

  function reportSignature() {
    return SYSTEM_SIGNATURE ? `<div class="report-signature">${SYSTEM_SIGNATURE}</div>` : "";
  }

  function gestorAccessAllowedByConfig(user) {
    const authCfg = cfg.auth || {};
    // Mantém a trava por lista de e-mails quando ela existir.
    // Se a lista estiver vazia/removida, o sistema permite o primeiro gestor criar o perfil.
    const list = (authCfg.adminEmails || []).map((e) => String(e).toLowerCase().trim()).filter(Boolean);
    if (!list.length) return { allowed: true, role: "admin", source: "config-empty" };
    return emailIsAdmin(user.email) ? { allowed: true, role: "admin", source: "config" } : { allowed: false };
  }

  async function gestorAccessAllowedByRegistry(user) {
    const email = String(user && user.email || "").toLowerCase().trim();
    if (!email) return { allowed: false };
    try {
      const snap = await db.collection("managerAccess").doc(email).get();
      if (!snap.exists) return { allowed: false };
      const data = snap.data() || {};
      const role = normalizedRole(data.role || "admin");
      if (data.active === false) return { allowed: false, reason: "inactive" };
      if (!OFFICE_ROLES.includes(role)) return { allowed: false, reason: "not-manager-role" };
      return { allowed: true, role, source: "managerAccess" };
    } catch (err) {
      console.warn("Falha ao verificar managerAccess", err);
      return { allowed: false, error: err };
    }
  }

  async function emailReservedForManager(email) {
    const normalized = String(email || "").toLowerCase().trim();
    if (!normalized) return false;
    if (emailIsAdmin(normalized)) return true;
    try {
      const snap = await db.collection("managerAccess").doc(normalized).get();
      return snap.exists && (snap.data() || {}).active !== false;
    } catch (err) {
      console.warn("Falha ao verificar gestor reservado", err);
      return false;
    }
  }

  async function saveGestorProfile(ref, profile, existingData) {
    const payload = existingData ? profile : Object.assign({ createdAt: ts() }, profile);
    await ref.set(payload, { merge: true });
    return { id: profile.uid, ...(existingData || {}), ...profile };
  }

  async function ensureGestorProfile(user) {
    const ref = db.collection("users").doc(user.uid);
    const snap = await ref.get();
    const current = snap.exists ? { id: user.uid, ...snap.data() } : null;

    if (current && current.active === false) {
      throw new Error("Este usuário está inativo no cadastro da JM Guinchos.");
    }

    const baseProfile = {
      uid: user.uid,
      email: user.email,
      nome: (current && current.nome) || user.displayName || user.email.split("@")[0],
      active: true,
      updatedAt: ts()
    };

    if (current && OFFICE_ROLES.includes(normalizedRole(current.role))) {
      return { ...current, role: normalizedRole(current.role) };
    }

    const configAccess = gestorAccessAllowedByConfig(user);
    const registryAccess = configAccess.allowed ? configAccess : await gestorAccessAllowedByRegistry(user);
    if (!registryAccess.allowed) {
      throw new Error("Este e-mail não está liberado como gestor. Crie/libere o gestor no superadmin antes de acessar o jm.html.");
    }

    // Correção definitiva do bug: jm.html é painel gestor.
    // Se o usuário foi criado como driver/motorista por fluxo antigo, repara para admin/financeiro
    // usando a autorização por e-mail gravada pelo superadmin em managerAccess/{email}.
    const repairedProfile = {
      ...baseProfile,
      role: registryAccess.role || "admin",
      loginFixedAt: new Date().toISOString(),
      loginFlowVersion: LOGIN_FLOW_VERSION,
      managerAccessSource: registryAccess.source || "unknown"
    };

    try {
      return await saveGestorProfile(ref, repairedProfile, current || null);
    } catch (err) {
      if (err && err.code === "permission-denied") {
        throw new Error("O login foi aceito, mas o Firestore bloqueou a correção do perfil. Publique as novas firestore.rules deste ZIP ou altere o documento users/" + user.uid + " para role: admin.");
      }
      throw err;
    }
  }



  function setTrackerStatus(message, type) {
    const el = $("trackerStatus");
    if (!el) return;
    el.textContent = message;
    el.className = "muted small " + (type || "");
  }

  async function syncTrackerNow(manual) {
    const tracker = activeTrackerSettings();
    const providers = visibleRows(state.trackerProviders).filter((p) => p.active !== false);
    if (!providers.length && (!tracker.endpoint || !tracker.token)) {
      setTrackerStatus("Tracker sem endpoint/token. Configure RAFA ou um provedor no superadmin.", "warn");
      if (manual) toast("Configure endpoint e token do Tracker ou cadastre um provedor no superadmin.", "danger");
      return [];
    }
    if (!canManageTracker()) {
      setTrackerStatus("Tracker ativo somente para gestor/gerente sincronizar.", "warn");
      return [];
    }
    if (trackerBusy) return [];
    trackerBusy = true;
    try {
      setTrackerStatus(providers.length ? "Sincronizando rastreadores ativos..." : "Sincronizando Tracker RAFA...", "info");
      const positions = window.JM.tracker.syncAllTrackersToFirestore
        ? await window.JM.tracker.syncAllTrackersToFirestore({ legacyTracker: tracker, providers, db, vehicles: state.vehicles })
        : await window.JM.tracker.syncTrackerToFirestore(tracker, db, state.vehicles);
      const matched = positions.filter((p) => p.trackerMatched).length;
      const unmapped = positions.length - matched;
      const now = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      const detail = unmapped > 0 ? ` (${unmapped} sem vinculo com placa; ajuste o deviceId no superadmin)` : "";
      setTrackerStatus(`Rastreamento sincronizado: ${positions.length} posição(ões), ${matched} vinculada(s) às ${now}${detail}.`, unmapped > 0 ? "warn" : "ok");
      if (manual) toast(`${positions.length} posição(ões) sincronizada(s), ${matched} vinculada(s).${detail}`, unmapped > 0 ? "warn" : "ok");
      return positions;
    } catch (err) {
      console.error(err);
      setTrackerStatus("Falha no Tracker: " + (err && err.message || err), "danger");
      if (manual) toast("Falha no Tracker: " + (err && err.message || err), "danger");
      return [];
    } finally {
      trackerBusy = false;
    }
  }

  function restartTrackerAutoSync() {
    if (trackerTimer) {
      clearInterval(trackerTimer);
      trackerTimer = null;
    }
    const tracker = activeTrackerSettings();
    const providers = visibleRows(state.trackerProviders).filter((p) => p.active !== false);
    if (!providers.length && (!tracker.endpoint || !tracker.token)) {
      setTrackerStatus("Tracker aguardando endpoint/token no superadmin.", "warn");
      return;
    }
    const providerPolling = providers.length ? providers.reduce((min, p) => Math.min(min, Number(p.pollingMs || 30000)), 30000) : Number(tracker.pollingMs || 30000);
    const polling = Math.max(15000, providerPolling);
    setTrackerStatus("Rastreamento configurado. Atualização automática a cada " + Math.round(polling / 1000) + "s.", "ok");
    syncTrackerNow(false);
    trackerTimer = setInterval(() => syncTrackerNow(false), polling);
  }


  function clearPublicChatListeners() {
    Object.values(state.publicChatUnsubs || {}).forEach((fn) => {
      try { fn(); } catch (_) {}
    });
    state.publicChatUnsubs = {};
    state.publicChatMessages = {};
  }

  function publicChatUnreadCount(call) {
    const token = call && call.publicToken;
    const rows = token && state.publicChatMessages[token] || [];
    return rows.filter((msg) => msg && msg.senderType === "client" && !msg.readAt).length;
  }

  function syncPublicChatListeners() {
    const activeTokens = new Set(visibleRows(state.calls).filter((call) => call.publicToken && !call.publicRevoked).map((call) => call.publicToken));
    Object.keys(state.publicChatUnsubs || {}).forEach((token) => {
      if (activeTokens.has(token)) return;
      try { state.publicChatUnsubs[token](); } catch (_) {}
      delete state.publicChatUnsubs[token];
      delete state.publicChatMessages[token];
    });
    activeTokens.forEach((token) => {
      if (state.publicChatUnsubs[token]) return;
      state.publicChatUnsubs[token] = db.collection("publicCalls").doc(token).collection("messages").orderBy("createdAt", "asc").limit(80).onSnapshot((snap) => {
        const rows = [];
        snap.forEach((doc) => rows.push({ id: doc.id, ...doc.data() }));
        state.publicChatMessages[token] = rows;
        renderAll();
      }, (err) => {
        console.warn("Falha ao ouvir chat público", err);
        state.publicChatMessages[token] = [];
      });
    });
  }

  function listenCollection(name, target) {
    const unsub = db.collection(name).onSnapshot((snap) => {
      const rows = {};
      snap.forEach((doc) => { rows[doc.id] = { id: doc.id, ...doc.data() }; });
      state[target] = rows;
      if (target === "calls") syncPublicChatListeners();
      renderAll();
    }, (err) => {
      console.error(err);
      toast("Falha ao ouvir " + name + ": " + err.message, "danger");
    });
    unsubscribers.push(unsub);
  }

  function startListeners() {
    unsubscribers.splice(0).forEach((fn) => fn());
    const baseCollections = ["vehicles", "calls", "users", "customers", "integrationInbox", "trackerProviders"];
    if (canManageFinance()) baseCollections.push("expenses", "transactions");
    if (canManageFleet() || canManageFinance()) baseCollections.push("maintenance");
    baseCollections.forEach((name) => listenCollection(name, name));
    const settingsUnsub = db.collection("settings").doc("integrations").onSnapshot((snap) => {
      state.settings = snap.exists ? snap.data() : {};
      initializeAddressTools();
      restartTrackerAutoSync();
      startMobileGpsRealtimeListeners();
      renderAll();
    });
    unsubscribers.push(settingsUnsub);
  }

  function stopListeners() {
    unsubscribers.splice(0).forEach((fn) => fn());
    if (trackerTimer) { clearInterval(trackerTimer); trackerTimer = null; }
    clearMobileGpsRealtimeListeners();
    clearPublicChatListeners();
  }

  function applyRoleVisibility() {
    const visibility = {
      finalizados: isOffice(),
      clientes: isOffice(),
      integracoes: canOperateCalls(),
      financeiro: canManageFinance(),
      pagamentos: canManageFinance(),
      frota: canManageFleet(),
      equipe: canManageTeam()
    };
    Object.entries(visibility).forEach(([view, allowed]) => {
      const btn = document.querySelector(`#navButtons button[data-view="${view}"]`);
      if (btn) btn.classList.toggle("hidden", !allowed);
    });
    // Importante: nunca redirecionar o jm.html para motorista.html.
    const active = document.querySelector(".view.active");
    if (active) {
      const current = active.id.replace("view-", "");
      if (visibility[current] === false) showView("dashboard");
    }
  }

  auth.onAuthStateChanged(async (user) => {
    stopListeners();
    state.user = user || null;
    state.profile = null;
    if (!user) {
      $("loginView").classList.remove("hidden");
      $("appView").classList.add("hidden");
      return;
    }

    try {
      state.profile = await ensureGestorProfile(user);
      $("loginView").classList.add("hidden");
      $("appView").classList.remove("hidden");
      $("userBox").innerHTML = `<b>${esc(state.profile.nome || user.email)}</b><br>${esc(user.email)}<br><span class="badge info">${esc(state.profile.role)}</span>`;
      applyRoleVisibility();
      startListeners();
    } catch (err) {
      $("appView").classList.add("hidden");
      $("loginView").classList.remove("hidden");
      $("loginError").textContent = err && err.message ? err.message : "Acesso de gestor não autorizado.";
      await auth.signOut().catch(() => {});
    }
  });

  $("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    $("loginError").textContent = "";
    try {
      await auth.signInWithEmailAndPassword($("loginEmail").value.trim(), $("loginPass").value);
    } catch (err) {
      $("loginError").textContent = friendlyAuthError(err);
    }
  };

  function friendlyAuthError(err) {
    const code = err && err.code || "";
    if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
      return "Usuário ou senha inválidos. O acesso de gestor deve existir no Firebase Authentication.";
    }
    if (code === "auth/operation-not-allowed") {
      return "Ative o provedor E-mail/Senha no Firebase Authentication.";
    }
    if (code === "auth/too-many-requests") {
      return "Muitas tentativas. Aguarde alguns minutos ou redefina a senha no Firebase.";
    }
    return "Acesso negado: " + (err && err.message || "falha de autenticação");
  }

  function renderAll() {
    renderSelects();
    renderDashboard();
    renderOperations();
    renderCalls();
    renderFinalizedCalls();
    renderCallDossier();
    renderCustomers();
    renderIntegrationInbox();
    renderVehicles();
    renderMaintenance();
    renderVehicleCostsLedger();
    renderTeam();
    if ($("driverCalls")) renderDriverPanel();
    renderFinance();
    renderPayments();
    renderInsuranceClosings();
    renderAiReview();
    refreshMaps();
  }

  function setOptionsPreservingValue(id, html) {
    const el = $(id);
    if (!el) return;
    const current = el.value;
    el.innerHTML = html;
    if (current && Array.from(el.options).some((opt) => opt.value === current)) el.value = current;
  }

  function renderSelects() {
    const vehicles = visibleRows(state.vehicles);
    const calls = visibleRows(state.calls);
    const customers = visibleRows(state.customers).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    const customerOptions = customers.map((c) => `<option value="${esc(c.id)}">${esc(c.name || c.razaoSocial || c.id)}${c.type ? " - " + esc(c.type) : ""}</option>`).join("");
    setOptionsPreservingValue("callCustomerId", `<option value="">Cliente avulso</option>${customerOptions}`);
    setOptionsPreservingValue("finCustomer", `<option value="">Sem cliente</option>${customerOptions}`);
    setOptionsPreservingValue("payCustomer", `<option value="">Selecione</option>${customerOptions}`);
    const vehicleOptions = vehicles.map((v) => `<option value="${esc(v.id)}">${esc(v.placa || v.id)} - ${esc(v.apelido || v.tipo || "")}</option>`).join("");
    setOptionsPreservingValue("callVehicle", `<option value="">Selecione</option>${vehicleOptions}`);
    setOptionsPreservingValue("expenseVehicle", `<option value="">Selecione</option>${vehicleOptions}`);
    setOptionsPreservingValue("finVehicle", `<option value="">Sem veículo</option>${vehicleOptions}`);
    setOptionsPreservingValue("maintenanceVehicle", `<option value="">Selecione</option>${vehicleOptions}`);
    const providerOptions = visibleRows(state.trackerProviders)
      .sort((a, b) => Number(a.priority || 50) - Number(b.priority || 50))
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)} - ${esc(p.providerType || "")}</option>`).join("");
    setOptionsPreservingValue("vehicleTrackerProvider", `<option value="">RAFA/automático</option>${providerOptions}<option value="mobile_gps">GPS celular</option><option value="manual">Manual</option>`);
    const drivers = visibleRows(state.users).filter((u) => u.active !== false && DRIVER_ROLES.includes(normalizedRole(u.role)));
    const driverOptions = drivers.map((u) => `<option value="${esc(u.id)}">${esc(u.nome || u.email)}</option>`).join("");
    setOptionsPreservingValue("callDriver", `<option value="">Selecione</option>` + drivers.map((u) => `<option value="${esc(u.id)}">${esc(u.nome || u.email)}</option>`).join(""));
    setOptionsPreservingValue("finDriver", `<option value="">Sem motorista</option>${driverOptions}`);
    const callOptions = calls.map((c) => `<option value="${esc(c.id)}">${esc(c.protocolo || c.cliente || c.id)}</option>`).join("");
    setOptionsPreservingValue("finCall", `<option value="">Sem chamado</option>${callOptions}`);
    setOptionsPreservingValue("payCall", `<option value="">Sem chamado</option>${callOptions}`);
    const myCalls = calls.filter((c) => c.driverId === state.user?.uid && !isFinalStatus(c));
    setOptionsPreservingValue("expenseCall", `<option value="">Sem chamado</option>` + myCalls.map((c) => `<option value="${esc(c.id)}">${esc(c.protocolo || c.cliente)}</option>`).join(""));
  }

  function vehicleLivePoint(vehicle) {
    return pointFrom(vehicle && (
      vehicle.location ||
      vehicle.lastLocation ||
      vehicle.lastKnownLocation ||
      vehicle.trackerLocation ||
      vehicle.trackerLastLocation ||
      vehicle.trackerPosition ||
      vehicle.lastPosition ||
      vehicle.mobileLocation ||
      vehicle.driverPhoneLocation ||
      vehicle.phoneLocation
    ));
  }

  function phoneGpsForVehicle(vehicleId) {
    if (!isMobileGpsEnabled() || !vehicleId) return null;
    if (isMobileGpsRealtime()) {
      const rt = state.mobileGps && state.mobileGps.vehicles && state.mobileGps.vehicles[rtdbKey(vehicleId)];
      const p = rt && pointFrom(rt.point || rt.location || rt);
      const rawCallId = rt && (rt.rawCallId || rt.sourceCallId || rt.callOriginalId || rt.callId) || "";
      if (p) return { point: p, call: state.calls[rawCallId] || state.calls[rt.callId] || { id: rawCallId || rt.callId || "", phoneLocationUpdatedAt: rt.capturedAt || rt.updatedAt } };
    }
    const rows = visibleRows(state.calls).filter((call) => call.vehicleId === vehicleId && call.phoneLocationActive);
    rows.sort((a, b) => String(b.phoneLocationUpdatedAt || b.updatedAt || "").localeCompare(String(a.phoneLocationUpdatedAt || a.updatedAt || "")));
    const call = rows[0];
    const p = call && pointFrom(call.driverPhoneLocation || call.mobileLocation || call.driverLocation);
    return p ? { point: p, call } : null;
  }

  function vehicleWithLiveGps(vehicle) {
    if (!vehicle) return vehicle;
    const phone = phoneGpsForVehicle(vehicle.id);
    if (phone && (!vehicleLivePoint(vehicle) || String(vehicle.gpsSource || "").includes("driver_phone"))) {
      return Object.assign({}, vehicle, {
        location: phone.point,
        mobileLocation: phone.point,
        gpsSource: isMobileGpsRealtime() ? "driver_phone_rtdb" : "driver_phone",
        trackerStatus: isMobileGpsRealtime() ? "GPS celular motorista (Realtime DB)" : "GPS celular motorista",
        lastPhoneGpsAt: phone.call.phoneLocationUpdatedAt || phone.point.capturedAt,
        lastTrackerAt: phone.call.phoneLocationUpdatedAt || phone.point.capturedAt,
        activeCallId: phone.call.id
      });
    }
    const lastPoint = vehicleLivePoint(vehicle);
    if (lastPoint && !pointFrom(vehicle.location)) {
      return Object.assign({}, vehicle, {
        location: lastPoint,
        trackerStatus: vehicle.trackerStatus || "Última localização conhecida",
        lastTrackerAt: vehicle.lastTrackerAt || vehicle.trackerLastUpdateAt || vehicle.updatedAt || vehicle.lastLocationAt || ""
      });
    }
    return vehicle;
  }

  function vehicleIdFromMobileGpsKey(key, rt) {
    const rawVehicleId = rt && (rt.rawVehicleId || rt.sourceVehicleId || rt.vehicleOriginalId) || "";
    if (rawVehicleId && state.vehicles[rawVehicleId]) return rawVehicleId;
    const payloadVehicleId = rt && rt.vehicleId || "";
    if (payloadVehicleId && state.vehicles[payloadVehicleId]) return payloadVehicleId;
    return Object.keys(state.vehicles || {}).find((id) => rtdbKey(id) === key) || rawVehicleId || payloadVehicleId || key;
  }

  function appendMobileGpsSideMarkers(vehicles) {
    if (!isMobileGpsEnabled() || !isMobileGpsRealtime()) return vehicles;
    Object.entries(state.mobileGps && state.mobileGps.vehicles || {}).forEach(([key, rt]) => {
      if (!rt || rt.active === false) return;
      const point = pointFrom(rt.point || rt.location || rt);
      if (!point) return;
      const vehicleId = vehicleIdFromMobileGpsKey(key, rt);
      const base = vehicles[vehicleId] || state.vehicles[vehicleId] || {};
      const basePoint = vehicleLivePoint(base);
      const baseSource = String(base.gpsSource || base.trackerLastSource || base.trackerSource || "");
      const hasIndependentTracker = !!basePoint && !baseSource.includes("driver_phone");
      if (!hasIndependentTracker) return;
      const markerId = vehicleId + "__gps_celular";
      vehicles[markerId] = Object.assign({}, base, {
        id: markerId,
        realVehicleId: vehicleId,
        placa: (base.placa || vehicleId || "Veículo") + " - celular",
        apelido: "GPS celular do motorista",
        location: point,
        mobileLocation: point,
        driverPhoneLocation: point,
        gpsSource: "driver_phone_rtdb",
        trackerStatus: "GPS celular motorista (Realtime DB)",
        lastPhoneGpsAt: rt.updatedAt || rt.capturedAt || rt.point && rt.point.capturedAt || "",
        lastTrackerAt: rt.updatedAt || rt.capturedAt || rt.point && rt.point.capturedAt || "",
        activeCallId: rt.rawCallId || rt.callOriginalId || rt.callId || "",
        activeDriverId: rt.driverId || "",
        activeDriverName: rt.driverName || ""
      });
    });
    return vehicles;
  }

  function renderDashboard() {
    const calls = visibleRows(state.calls);
    const active = calls.filter((c) => !isFinalStatus(c.status));
    const now = new Date();
    const transactions = visibleRows(state.transactions);
    const expenses = visibleRows(state.expenses);
    const finalized = calls.filter((c) => isFinalStatus(c.status));
    const toBill = finalized.filter((c) => ["a_faturar", "aguardando_provas", "aberto"].includes(String(c.billingStatus || "aberto")));
    const overdueSla = active.filter((c) => slaInfo(c).overdue);
    const incompleteProofs = active.concat(toBill).filter((c) => !callProofComplete(c));
    const receivables = transactions.filter((t) => t.type === "entrada" && ["A receber", "A faturar", "Pendente"].includes(String(t.status || ""))).reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const payables = transactions.filter((t) => t.type === "saida" && ["A pagar", "Pendente"].includes(String(t.status || ""))).reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const revenue = transactions.filter((t) => t.type === "entrada").filter((t) => {
      const d = new Date(t.date || t.createdAt || 0);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const pendingExpenses = expenses.filter((e) => e.status === "pendente").reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const online = visibleRows(state.vehicles).map(vehicleWithLiveGps).filter((v) => vehicleLivePoint(v) && (v.lastTrackerAt || v.lastPhoneGpsAt)).length;
    $("kpiActiveCalls").textContent = active.length;
    $("kpiRevenue").textContent = canSeeSensitiveFinance() ? money(revenue) : "Restrito";
    $("kpiExpenses").textContent = canSeeSensitiveFinance() ? money(pendingExpenses) : "Restrito";
    $("kpiOnline").textContent = online;
    if ($("dashboardOpsKpis")) {
      $("dashboardOpsKpis").innerHTML = `
        <div class="card kpi"><span>Finalizados</span><strong>${finalized.length}</strong></div>
        <div class="card kpi"><span>A faturar / provas</span><strong>${toBill.length}</strong></div>
        <div class="card kpi"><span>SLA vencido</span><strong>${overdueSla.length}</strong></div>
        <div class="card kpi"><span>Provas pendentes</span><strong>${incompleteProofs.length}</strong></div>
        <div class="card kpi"><span>A receber</span><strong>${canSeeSensitiveFinance() ? money(receivables) : "Restrito"}</strong></div>
        <div class="card kpi"><span>A pagar</span><strong>${canSeeSensitiveFinance() ? money(payables) : "Restrito"}</strong></div>`;
    }
    const events = calls.flatMap((c) => (c.timeline || []).map((t) => ({ ...t, call: c }))).sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 10);
    $("timelineBox").innerHTML = events.length ? events.map((e) => `<div class="timeline-item"><b>${esc(e.call.protocolo || e.call.cliente || "Chamado")}</b><br><span>${esc(e.text || "")}</span><br><small>${dateTime(e.at)}</small></div>`).join("") : `<p class="muted">Sem eventos ainda.</p>`;
  }

  function filteredOperationCalls() {
    const filter = state.operationFilter || "ativos";
    return visibleRows(state.calls).filter((c) => {
      if (filter === "todos") return true;
      if (filter === "ativos") return !isFinalStatus(c.status);
      return currentStatusKey(c) === filter || operationalStatus(c) === filter;
    }).filter((c) => {
      if (state.operationPriorityFilter && String(c.priority || "") !== state.operationPriorityFilter) return false;
      if (state.operationInsuranceFilter && String(c.insurance || c.source || "") !== state.operationInsuranceFilter) return false;
      if (state.operationDriverFilter && String(c.driverId || "") !== state.operationDriverFilter) return false;
      if (state.operationVehicleFilter && String(c.vehicleId || "") !== state.operationVehicleFilter) return false;
      return true;
    }).sort((a, b) => {
      const pa = priorityWeight(a) - priorityWeight(b);
      if (pa) return pa;
      const sa = slaInfo(a).overdue ? -1 : 0;
      const sb = slaInfo(b).overdue ? -1 : 0;
      if (sa !== sb) return sa - sb;
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });
  }

  function renderOperations() {
    if (!$("opsKpis")) return;
    const calls = visibleRows(state.calls);
    const active = calls.filter((c) => !isFinalStatus(c.status));
    const waiting = active.filter((c) => currentStatusKey(c) === "aguardando_despacho");
    const inRoute = active.filter((c) => ["despachado", "motorista_a_caminho", "motorista_no_local", "veiculo_carregado", "em_transporte"].includes(currentStatusKey(c)));
    const insurance = active.filter((c) => String(c.source || c.origemComercial || "").toLowerCase().includes("segur") || String(c.insurance || "").trim());
    const onlineVehicles = visibleRows(state.vehicles).map(vehicleWithLiveGps).filter((v) => vehicleLivePoint(v) && (v.lastTrackerAt || v.lastPhoneGpsAt));
    const overdue = active.filter((c) => slaInfo(c).overdue);
    const visibleValue = canSeeSensitiveFinance() ? money(active.reduce((s, c) => s + Number(c.valor || 0), 0)) : "Restrito";
    const insuranceOptions = Array.from(new Set(active.map((c) => c.insurance || c.source || "").filter(Boolean))).sort();
    const driverOptions = visibleRows(state.users).filter((u) => u.active !== false && DRIVER_ROLES.includes(normalizedRole(u.role)));
    const vehicleOptions = visibleRows(state.vehicles).sort((a, b) => String(a.placa || a.id || "").localeCompare(String(b.placa || b.id || "")));
    setOptionsPreservingValue("opsInsuranceFilter", `<option value="">Todas seguradoras</option>` + insuranceOptions.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join(""));
    setOptionsPreservingValue("opsDriverFilter", `<option value="">Todos motoristas</option>` + driverOptions.map((u) => `<option value="${esc(u.id)}">${esc(u.nome || u.email)}</option>`).join(""));
    setOptionsPreservingValue("opsVehicleFilter", `<option value="">Todos veículos</option>` + vehicleOptions.map((v) => `<option value="${esc(v.id)}">${esc(v.placa || v.id)}</option>`).join(""));
    $("opsKpis").innerHTML = `
      <div class="card kpi col-3"><span>Fila ativa</span><strong>${active.length}</strong></div>
      <div class="card kpi col-3"><span>Aguardando despacho</span><strong>${waiting.length}</strong></div>
      <div class="card kpi col-3"><span>Em atendimento</span><strong>${inRoute.length}</strong></div>
      <div class="card kpi col-3"><span>Seguradoras/assistências</span><strong>${insurance.length}</strong></div>
      <div class="card kpi col-3"><span>Frota online</span><strong>${onlineVehicles.length}</strong></div>
      <div class="card kpi col-3"><span>Sem rota precisa</span><strong>${active.filter((c) => !(c.routePrecision === "osrm_openstreetmap" || c.routeMetrics && c.routeMetrics.fullRoute && c.routeMetrics.fullRoute.isPrecise)).length}</strong></div>
      <div class="card kpi col-3"><span>Urgentes</span><strong>${active.filter((c) => String(c.priority).toLowerCase() === "urgente").length}</strong></div>
      <div class="card kpi col-3"><span>SLA vencido</span><strong>${overdue.length}</strong></div>
      <div class="card kpi col-3"><span>Valor previsto ativo</span><strong>${visibleValue}</strong></div>`;

    const filtered = filteredOperationCalls();
    if (!state.selectedCallId && filtered.length) state.selectedCallId = filtered[0].id;
    if (state.selectedCallId && (!state.calls[state.selectedCallId] || state.calls[state.selectedCallId].deletedAt)) state.selectedCallId = filtered[0] && filtered[0].id || null;
    const selectedCall = state.calls[state.selectedCallId] || null;
    $("opsCallsList").innerHTML = filtered.length ? filtered.map((c) => {
      const selected = c.id === state.selectedCallId ? " selected" : "";
      const vehicle = state.vehicles[c.vehicleId] || {};
      const driver = state.users[c.driverId] || {};
      const st = operationalStatus(c);
      const sla = slaInfo(c);
      const routeOk = c.routePrecision === "osrm_openstreetmap" || c.routeMetrics && c.routeMetrics.fullRoute && c.routeMetrics.fullRoute.isPrecise;
      const wa = phoneWhatsappUrl(c.phone, `JM Guinchos - chamado ${c.protocolo || c.id}`);
      return `<div class="ops-card${selected}" onclick="JM.app.selectOperationalCall('${esc(c.id)}')">
        <div class="actions" style="justify-content:space-between"><b>${esc(c.protocolo || c.cliente || c.id)}</b><span class="badge ${statusClass(st)}">${esc(st)}</span></div>
        <div class="small"><b>${esc(c.cliente || "Cliente")}</b> ${c.phone ? `· ${esc(c.phone)}` : ""}</div>
        <div class="muted small">${esc(c.source || "Particular")}${c.insurance ? ` · ${esc(c.insurance)}` : ""}${c.insuranceProtocol ? ` · Prot. ${esc(c.insuranceProtocol)}` : ""}</div>
        <div class="small">${esc(c.originLabel || c.origem && c.origem.label || "Origem não informada")} → ${esc(c.destLabel || c.destino && c.destino.label || "Destino aberto")}</div>
        <div class="muted small">Frota: ${esc(vehicle.placa || "sem veículo")} · Motorista: ${esc(driver.nome || driver.email || "sem motorista")}</div>
        <div class="actions ops-mini-actions">
          <button class="btn" type="button" onclick="event.stopPropagation();JM.app.setCallStatus('${esc(c.id)}','motorista_a_caminho')">A caminho</button>
          <button class="btn" type="button" onclick="event.stopPropagation();JM.app.setCallStatus('${esc(c.id)}','motorista_no_local')">No local</button>
          <button class="btn" type="button" onclick="event.stopPropagation();JM.app.setCallStatus('${esc(c.id)}','em_transporte')">Transporte</button>
          <button class="btn good" type="button" onclick="event.stopPropagation();JM.app.setCallStatus('${esc(c.id)}','finalizado')">Finalizar</button>
          ${wa ? `<a class="btn" href="${esc(wa)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">WhatsApp</a>` : ""}
          ${quickCallLinks(c, vehicle, { stopPropagation: true })}
        </div>
        <div>${routeOk ? '<span class="badge ok">Rota por ruas</span>' : '<span class="badge warn">Rota estimada</span>'} <span class="badge ${sla.className}">${esc(sla.label)}</span> ${proofStatusBadge(c)} ${String(c.priority).toLowerCase() === 'urgente' ? '<span class="badge danger">Urgente</span>' : ''}</div>
      </div>`;
    }).join("") : `<p class="muted">Nenhum chamado no filtro selecionado.</p>`;

    const vehicles = visibleRows(state.vehicles).map(vehicleWithLiveGps).sort((a, b) => String(a.placa || a.id || "").localeCompare(String(b.placa || b.id || "")));
    if (!state.selectedVehicleId && selectedCall && selectedCall.vehicleId) state.selectedVehicleId = selectedCall.vehicleId;
    $("opsVehiclesList").innerHTML = vehicles.length ? vehicles.map((v) => {
      const selected = v.id === state.selectedVehicleId ? " selected" : "";
      const livePoint = vehicleLivePoint(v);
      const gpsAt = v.lastPhoneGpsAt || v.lastTrackerAt || v.updatedAt;
      const age = minutesSince(gpsAt);
      const online = livePoint && age != null && age <= 10;
      const stale = livePoint && age != null && age > 10;
      const gpsLabel = String(v.gpsSource || "").includes("driver_phone") ? (isMobileGpsRealtime() ? "GPS celular RTDB" : "GPS celular") : "Tracker RAFA";
      return `<div class="ops-card vehicle${selected}" onclick="JM.app.selectOperationalVehicle('${esc(v.id)}')">
        <div class="actions" style="justify-content:space-between"><b>${esc(v.placa || v.id)}</b><span class="badge ${online ? 'ok' : stale ? 'warn' : 'muted'}">${online ? 'online' : stale ? 'atrasado' : 'sem GPS'}</span></div>
        <div class="muted small">${esc(v.apelido || v.tipo || "Veículo")} · ${livePoint ? esc(gpsLabel) : 'sem sinal'}</div>
        <div class="small">${livePoint ? `Lat ${esc(livePoint.lat)} · Lng ${esc(livePoint.lng)}` : 'Sem posição do tracker'}</div>
        <div class="muted small">${age == null ? 'sem atualização' : 'última posição há ' + age + ' min'}</div>
      </div>`;
    }).join("") : `<p class="muted">Nenhum veículo cadastrado.</p>`;

    const hint = $("opsMapHint");
    if (hint) {
      const v = state.vehicles[state.selectedVehicleId];
      hint.textContent = selectedCall ? `Chamado selecionado: ${selectedCall.protocolo || selectedCall.cliente || selectedCall.id}. Veículo: ${v ? (v.placa || v.id) : 'não selecionado'}.` : "Selecione um chamado para acompanhar no mapa.";
    }
  }

  function selectOperationalCall(id) {
    state.selectedCallId = id;
    const call = state.calls[id];
    if (call && call.vehicleId) state.selectedVehicleId = call.vehicleId;
    renderOperations();
    refreshMaps();
  }

  function selectOperationalVehicle(id) {
    state.selectedVehicleId = id;
    renderOperations();
    refreshMaps();
  }

  async function assignSelectedVehicleToSelectedCall() {
    if (!canOperateCalls()) return toast("Somente equipe operacional autorizada pode despachar.", "danger");
    const callId = state.selectedCallId;
    const vehicleId = state.selectedVehicleId;
    if (!callId || !vehicleId) return toast("Selecione um chamado e um veículo.", "danger");
    const vehicle = state.vehicles[vehicleId];
    await db.collection("calls").doc(callId).update({
      vehicleId,
      status: "Despachado",
      statusKey: "despachado",
      dispatchedAt: new Date().toISOString(),
      dispatchedBy: state.user.uid,
      timeline: arrayUnion({ at: new Date().toISOString(), by: state.profile.nome || state.user.email, text: "Veículo " + (vehicle && (vehicle.placa || vehicle.id) || vehicleId) + " despachado pela Central Operacional" })
    });
    await syncPublicCall(callId, { vehicleId, status: "Despachado", statusKey: "despachado" });
    toast("Veículo despachado para o chamado.", "ok");
  }

  function openSelectedCallRoute() {
    const call = state.calls[state.selectedCallId];
    if (!call) return toast("Selecione um chamado.", "danger");
    const url = routeForCall(call, state.selectedVehicleId);
    if (!url) return toast("Chamado sem rota/link. Preencha origem/destino.", "danger");
    window.open(url, "_blank");
  }

  async function copySelectedCallRoute() {
    const call = state.calls[state.selectedCallId];
    if (!call) return toast("Selecione um chamado.", "danger");
    const url = routeForCall(call, state.selectedVehicleId);
    if (!url) return toast("Chamado sem rota/link para copiar.", "danger");
    const text = `JM Guinchos - rota do chamado ${call.protocolo || call.id}
Cliente: ${call.cliente || ""}
Origem: ${call.originLabel || call.origem && call.origem.label || ""}
Destino: ${call.destLabel || call.destino && call.destino.label || ""}
Rota: ${url}`;
    try {
      await navigator.clipboard.writeText(text);
      toast("Link da rota copiado.", "ok");
    } catch (_) {
      window.prompt("Copie o texto da rota:", text);
    }
  }

  function callSearchText(call) {
    const vehicle = state.vehicles[call.vehicleId] || {};
    const driver = state.users[call.driverId] || {};
    return statusLower([
      call.protocolo, call.cliente, call.phone, call.source, call.insurance, call.insuranceProtocol,
      call.customerPlate, call.customerVehicle, call.originLabel, call.destLabel,
      call.origem && call.origem.label, call.destino && call.destino.label,
      vehicle.placa, vehicle.apelido, driver.nome, driver.email
    ].filter(Boolean).join(" "));
  }

  function callListFilter(prefix) {
    return {
      text: statusLower($(prefix + "Search") && $(prefix + "Search").value || ""),
      status: $(prefix + "StatusFilter") && $(prefix + "StatusFilter").value || "",
      source: statusLower($(prefix + "SourceFilter") && $(prefix + "SourceFilter").value || ""),
      billing: statusLower($(prefix + "BillingFilter") && $(prefix + "BillingFilter").value || "")
    };
  }

  function matchesCallListFilter(call, filter) {
    if (filter.status && currentStatusKey(call) !== filter.status) return false;
    if (filter.source) {
      const source = statusLower([call.source, call.insurance, call.origemComercial].filter(Boolean).join(" "));
      if (!source.includes(filter.source)) return false;
    }
    if (filter.billing && !statusLower(call.billingStatus).includes(filter.billing)) return false;
    if (filter.text && !callSearchText(call).includes(filter.text)) return false;
    return true;
  }

  function renderCalls() {
    const filter = callListFilter("calls");
    const rows = visibleRows(state.calls).filter((c) => !isFinalStatus(c) && matchesCallListFilter(c, filter)).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    if (!rows.length) return $("callsTable").innerHTML = `<p class="muted">Nenhum chamado registrado.</p>`;
    $("callsTable").innerHTML = `<table><thead><tr><th>Protocolo</th><th>Cliente</th><th>Origem/Destino</th><th>Veículo</th><th>Status</th><th>Ações</th></tr></thead><tbody>` + rows.map((c) => {
      const vehicle = state.vehicles[c.vehicleId] || {};
      const driver = state.users[c.driverId] || {};
      const url = c.routeExternalUrl || c.routeUrl || mapsRouteUrl(c, vehicle);
      const km = routeKm(c, vehicle);
      const metric = c.routeDistanceText || c.routeMetrics && c.routeMetrics.fullRoute && c.routeMetrics.fullRoute.distanceText || c.routeMetrics && c.routeMetrics.bestToOrigin && c.routeMetrics.bestToOrigin.distanceText || (km ? km.toFixed(1).replace(".", ",") + " km" : "Sem rota");
      const routeBadge = c.routePrecision === "osrm_openstreetmap" || c.routeMetrics && c.routeMetrics.fullRoute && c.routeMetrics.fullRoute.isPrecise ? `<br><span class="badge ok">Rota por ruas</span>` : `<br><span class="badge warn">Fallback/estimada</span>`;
      const tow = c.towPricing || c.deslocamentoGuincho || {};
      const towHtml = tow.ativo ? `<br><span class="badge info">Guincho ${esc(String(tow.kmTotal || 0).replace(".", ","))} km · ${canSeeSensitiveFinance() ? money(tow.total || 0) : "valor restrito"}</span>` : "";
      const adminActions = canOwnCompany() ? `<button class="btn" onclick="JM.app.editCall('${esc(c.id)}')">Editar</button><button class="btn danger" onclick="JM.app.deleteCall('${esc(c.id)}')">Excluir</button>` : "";
      const viewProofActions = proofStatus(c) !== "pendente" ? `<button class="btn" onclick="JM.app.viewCallProofs('${esc(c.id)}')">Ver provas</button>` : "";
      const proofActions = (canOwnCompany() || hasRole(["gerente"])) && proofStatus(c) === "completo" ? `<button class="btn good" onclick="JM.app.reviewCallProofs('${esc(c.id)}')">Revisar provas</button>` : "";
      const valueHtml = canSeeSensitiveFinance() ? `<br><b>${money(c.valor || 0)}</b>` : "";
      const sla = slaInfo(c);
      const unreadChat = publicChatUnreadCount(c);
      const chatBadge = unreadChat ? `<br><span class="badge danger">${unreadChat} mensagem(ns) do cliente</span>` : "";
      const quickLinks = quickCallLinks(c, vehicle);
      return `<tr>
        <td><b>${esc(c.protocolo || c.id)}</b><br><span class="muted small">${dateTime(c.createdAt)}</span></td>
        <td>${esc(c.cliente || "")}<br><span class="muted small">${esc(c.phone || "")}</span><br><span class="muted small">${esc(c.source || "Particular")}${c.insurance ? " · " + esc(c.insurance) : ""}${c.insuranceProtocol ? " · Prot. " + esc(c.insuranceProtocol) : ""}</span></td>
        <td><span class="small">${esc(c.originLabel || c.origem && c.origem.label || "-")}</span><br><span class="muted small">→ ${esc(c.destLabel || c.destino && c.destino.label || "-")}</span><br><b>${esc(metric)}</b>${routeBadge}${towHtml}${chatBadge}${url ? `<br><a class="info small" target="_blank" rel="noopener noreferrer" href="${esc(url)}">Abrir rota no Maps</a>` : ""}</td>
        <td>${esc(vehicle.placa || "-")}<br><span class="muted small">${esc(driver.nome || driver.email || "Sem motorista")}</span></td>
        <td><span class="badge ${statusClass(c)}">${esc(operationalStatus(c))}</span>${valueHtml}<br><span class="badge ${sla.className}">${esc(sla.label)}</span><br>${proofStatusBadge(c)}</td>
        <td class="row-actions"><button class="btn" onclick="JM.app.selectCallDossier('${esc(c.id)}')">Painel</button>${quickLinks}<button class="btn good" onclick="JM.app.setCallStatus('${esc(c.id)}','despachado')">Despachar</button><button class="btn primary" onclick="JM.app.setCallStatus('${esc(c.id)}','motorista_a_caminho')">A caminho</button><button class="btn" onclick="JM.app.setCallStatus('${esc(c.id)}','finalizado')">Finalizar</button>${viewProofActions}${proofActions}${adminActions}</td>
      </tr>`;
    }).join("") + `</tbody></table>`;
  }

  function selectCallDossier(id) {
    state.selectedDossierCallId = id;
    renderCallDossier();
    const box = $("callDossierBox");
    if (box) box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderFinalizedCalls() {
    if (!$("finalizedCallsTable")) return;
    const filter = callListFilter("finalized");
    const rows = visibleRows(state.calls).filter((c) => isFinalStatus(c) && matchesCallListFilter(c, filter)).sort((a, b) => String(b.closedAt || b.finalizedAt || b.updatedAt || "").localeCompare(String(a.closedAt || a.finalizedAt || a.updatedAt || "")));
    $("finalizedCallsTable").innerHTML = rows.length ? `<table><thead><tr><th>Chamado</th><th>Cliente/seguradora</th><th>Fechamento</th><th>Provas</th><th>Ações</th></tr></thead><tbody>` + rows.map((c) => {
      const driver = state.users[c.driverId] || {};
      const vehicle = state.vehicles[c.vehicleId] || {};
      const quickLinks = quickCallLinks(c, vehicle);
      return `<tr>
        <td><b>${esc(c.protocolo || c.id)}</b><br><span class="muted small">${esc(vehicle.placa || c.vehicleId || "sem veículo")}</span></td>
        <td>${esc(c.cliente || "")}<br><span class="muted small">${esc(c.insurance || c.source || "")}${c.insuranceProtocol ? " · Prot. " + esc(c.insuranceProtocol) : ""}</span></td>
        <td><span class="badge ok">${esc(operationalStatus(c))}</span><br><span class="muted small">${dateTime(c.closedAt || c.finalizedAt || c.updatedAt)} · ${esc(driver.nome || driver.email || "motorista")}</span><br><span class="badge ${c.locked !== false ? "warn" : "info"}">${c.locked !== false ? "travado" : "reaberto"}</span></td>
        <td>${proofStatusBadge(c)}<br><span class="muted small">Cobrança: ${esc(c.billingStatus || "aberto")}</span></td>
        <td class="row-actions"><button class="btn" onclick="JM.app.selectCallDossier('${esc(c.id)}')">Painel</button>${quickLinks}<button class="btn" onclick="JM.app.viewCallProofs('${esc(c.id)}')">Checklist/fotos</button>${canOwnCompany() || hasRole(["gerente"]) ? `<button class="btn warn" onclick="JM.app.reopenCall('${esc(c.id)}')">Reabrir</button>` : ""}</td>
      </tr>`;
    }).join("") + `</tbody></table>` : `<p class="muted">Nenhum chamado finalizado ainda.</p>`;
  }

  $("callForm").onsubmit = async (e) => {
    e.preventDefault();
    const submitBtn = e.submitter || document.querySelector("#callForm button[type='submit']");
    if (!canOperateCalls()) return toast("Somente equipe operacional autorizada pode registrar chamado.", "danger");
    const originAddress = addressFromInputs("origin");
    const destinationAddress = addressFromInputs("destination");
    if (!originAddress || !originAddress.coords) {
      return toast("Antes de registrar, informe a origem por link de mapa ou latitude/longitude real.", "danger");
    }
    const customerPlate = $("callCustomerPlate") ? plateKey($("callCustomerPlate").value) : "";
    if (customerPlate && !isValidPlate(customerPlate)) {
      return toast("Placa do cliente inválida. Use ABC1234 ou ABC1D23.", "danger");
    }
    if (($("callSource") && /segur|assist/i.test($("callSource").value)) && $("callInsuranceProtocol") && !$("callInsuranceProtocol").value.trim()) {
      return toast("Chamado de seguradora/assistência precisa de protocolo para não perder o rastreio do acionamento.", "danger");
    }
    const selectedVehicleId = $("callVehicle").value;
    const selectedDriverId = selectedDriverIdForCall();
    const best = bestSmartRoute();
    const routePoints = routePointsFromForm(true);
    const externalRouteUrl = currentExternalRouteUrl();
    const now = new Date().toISOString();
    setButtonBusy(submitBtn, true, "Salvando...");
    const selectedCustomer = $("callCustomerId") && $("callCustomerId").value ? state.customers[$("callCustomerId").value] || null : null;
    const towPricing = calculateTowPricing();
    const callPricingData = currentCallDataForPricing(towPricing);
    const manualPrice = preserveManualPrice(callPricingData);
    const pricingResult = calculateCurrentRoutePricing({ towPricing, syncTowForm: false, autoFill: false, render: true });
    const fallbackCallValue = manualPrice.manualPriceLocked
      ? manualPrice.manualValue
      : towPricing.ativo && towPricing.total > 0 ? towPricing.total : parseMoney($("callPrice").value);
    const callValue = pricingResult && pricingResult.pricingSuggestion
      ? Number(pricingResult.pricingSuggestion.finalValue || 0)
      : fallbackCallValue;
    const routeMetricsData = storeRouteMetrics(best);
    const currentEditingCall = state.editingCallId ? state.calls[state.editingCallId] || {} : {};
    if (pricingResult && routeMetricsData) Object.assign(routeMetricsData, pricingResult.routeMetrics || {});
    const baseData = {
      customerId: $("callCustomerId") ? $("callCustomerId").value : "",
      cliente: $("callClient").value.trim(),
      customerType: selectedCustomer && selectedCustomer.type || "",
      customerDocument: selectedCustomer && selectedCustomer.document || "",
      phone: $("callPhone").value.trim(),
      serviceType: $("callType").value,
      valor: callValue,
      priceMode: pricingResult && pricingResult.pricingSuggestion && pricingResult.pricingSuggestion.priceMode || manualPrice.priceMode,
      manualPriceLocked: pricingResult && pricingResult.pricingSuggestion ? !!pricingResult.pricingSuggestion.manualPriceLocked : manualPrice.manualPriceLocked,
      towPricing,
      deslocamentoGuincho: towPricing,
      totalGuincho: towPricing.total,
      source: $("callSource") ? $("callSource").value : "Particular",
      priority: $("callPriority") ? $("callPriority").value : "normal",
      insurance: $("callInsurance") ? $("callInsurance").value.trim() : "",
      insuranceProtocol: $("callInsuranceProtocol") ? $("callInsuranceProtocol").value.trim() : "",
      policy: $("callPolicy") ? $("callPolicy").value.trim() : "",
      claimNumber: $("callClaim") ? $("callClaim").value.trim() : "",
      policyNumber: $("callPolicyNumber") ? $("callPolicyNumber").value.trim() : "",
      billingStatus: $("callBillingStatus") ? $("callBillingStatus").value : "aberto",
      slaLimitAt: $("callSlaLimit") ? $("callSlaLimit").value : "",
      customerPlate,
      customerVehicle: $("callCustomerVehicle") ? $("callCustomerVehicle").value.trim() : "",
      extraKm: $("callExtraKm") ? parseMoney($("callExtraKm").value) : 0,
      vehicleId: selectedVehicleId,
      driverId: selectedDriverId,
      originLabel: originAddress.label,
      destLabel: destinationAddress && destinationAddress.label || "",
      origin: storePoint(originAddress.coords),
      destination: destinationAddress && storePoint(destinationAddress.coords) || null,
      origem: storeAddress(originAddress),
      destino: storeAddress(destinationAddress),
      routeWaypoints: (state.addresses.waypoints || []).map((row, index) => ({
        label: row && row.label || "Parada " + (index + 1),
        point: storePoint(row && (row.point || row.coords || row))
      })).filter((row) => row.point),
      routeExternalUrl: externalRouteUrl,
      routeProvider: externalRouteUrl ? "external_link" : "generated_google_maps_url",
      routeUrl: externalRouteUrl || (window.JM.googleMaps && window.JM.googleMaps.routeUrl(routePoints) || mapsRouteUrl(routePoints)),
      routeGeometry: best && best.fullRoute && geometryToFirestore(best.fullRoute.geometry) || currentEditingCall.routeGeometry || null,
      routePrecision: best && best.fullRoute && best.fullRoute.source || currentEditingCall.routePrecision || "pending_map_render",
      routeDistanceText: best && best.fullRoute && best.fullRoute.distanceText || currentEditingCall.routeDistanceText || "",
      routeDurationText: best && best.fullRoute && best.fullRoute.durationText || currentEditingCall.routeDurationText || "",
      routeMetrics: routeMetricsData || currentEditingCall.routeMetrics || null,
      integrationInboxId: state.pendingIntegrationId || "",
      notes: $("callNotes").value.trim()
    };
    if (pricingResult) {
      baseData.tollEstimate = pricingResult.tollEstimate;
      baseData.pricingSuggestion = pricingResult.pricingSuggestion;
      if (pricingResult.costEstimate) baseData.costEstimate = pricingResult.costEstimate;
    }
    const callDataForSave = prepareCallDataForFirestore(baseData);
    try {
      if (state.editingCallId) {
        if (!canOwnCompany() && !hasRole(["gerente"])) return toast("Somente gestor/dono ou gerente pode editar chamados.", "danger");
        const current = state.calls[state.editingCallId] || {};
        const nextKey = currentStatusKey(current) || (selectedDriverId ? "despachado" : "aguardando_despacho");
        await db.collection("calls").doc(state.editingCallId).set(Object.assign({}, callDataForSave, {
          status: statusLabel(nextKey),
          statusKey: nextKey,
          updatedAt: now,
          updatedBy: state.user.uid,
          timeline: arrayUnion({ at: now, by: personName(), text: "Chamado editado pela central" })
        }), { merge: true });
        if (current.receivableTransactionId && canManageFinance() && Math.abs(Number(current.valor || 0) - Number(callValue || 0)) > 0.009) {
          await upsertCallReceivable(state.editingCallId, { amount: callValue, expectedAmount: callValue, forceAmount: true, status: "A receber" });
        }
        resetCallForm();
        toast("Chamado atualizado.", "ok");
        return;
      }
      const protocolo = "JM-" + now.replace(/\D/g, "").slice(2, 14);
      const initialKey = selectedDriverId ? "despachado" : "aguardando_despacho";
      const callRef = await db.collection("calls").add(Object.assign({}, callDataForSave, {
        protocolo,
        status: statusLabel(initialKey),
        statusKey: initialKey,
        createdAt: now,
        createdBy: state.user.uid,
        timeline: [{ at: now, by: personName(), text: "Chamado criado com endereço validado e rota inteligente" }]
      }));
      if (state.pendingIntegrationId) {
        await db.collection("integrationInbox").doc(state.pendingIntegrationId).set({
          status: "convertido",
          convertedCallId: callRef.id,
          convertedAt: now,
          convertedBy: state.user.uid
        }, { merge: true }).catch(() => {});
        state.pendingIntegrationId = null;
      }
      resetCallForm();
      toast("Chamado registrado com dados de rota.", "ok");
    } catch (err) {
      console.error("Falha ao salvar chamado", err);
      toast("Falha ao salvar chamado: " + (err && err.message || "verifique Firebase, regras e tamanho do documento."), "danger");
    } finally {
      setButtonBusy(submitBtn, false);
    }
  };

  async function setCallStatus(id, status) {
    if (!canOperateCalls()) return toast("Somente equipe operacional autorizada pode alterar status.", "danger");
    const call = state.calls[id];
    if (!call) return;
    const key = statusKey(status);
    const label = statusLabel(key);
    if (isFinalStatus(call) && key !== "finalizado") {
      return toast("Chamado finalizado fica travado. Use Reabrir com autorização e motivo auditado.", "danger");
    }
    const updates = {
      status: label,
      statusKey: key,
      proofStatus: proofStatus(call),
      updatedAt: new Date().toISOString(),
      timeline: arrayUnion({ at: new Date().toISOString(), by: personName(), text: "Status alterado para " + label })
    };
    if (key === "finalizado" && !callProofComplete(call)) {
      updates.billingStatus = "aguardando_provas";
      updates.financePending = true;
      updates.closedAt = new Date().toISOString();
      updates.closedBy = state.user.uid;
      updates.closedByEmail = state.user.email;
      updates.locked = true;
      await db.collection("calls").doc(id).update(updates);
      await syncPublicCall(id, updates);
      return toast("Chamado marcado como finalizado operacional, mas não ficou pronto para faturar: faltam checklist, fotos obrigatórias ou assinatura/aceite.", "warn");
    }
    if (key === "finalizado" && Number(call.valor || 0) > 0) {
      updates.billingStatus = canManageFinance() ? "a_receber" : "a_faturar";
      updates.financePending = !canManageFinance();
    }
    if (key === "finalizado") {
      updates.closedAt = new Date().toISOString();
      updates.closedBy = state.user.uid;
      updates.closedByEmail = state.user.email;
      updates.locked = true;
      updates.finalizedAt = updates.closedAt;
    }
    await db.collection("calls").doc(id).update(updates);
    await syncPublicCall(id, updates);
    if (key === "finalizado" && Number(call.valor || 0) > 0 && canManageFinance()) {
      await upsertCallReceivable(id, { status: "A receber", amount: Number(call.valor || 0) });
      toast("Status atualizado e conta a receber do chamado gerada automaticamente.", "ok");
    } else if (key === "finalizado" && Number(call.valor || 0) > 0) {
      toast("Status atualizado. Chamado entrou como a faturar para o financeiro.", "ok");
    } else {
      toast("Status atualizado.", "ok");
    }
  }

  async function reopenCall(id) {
    if (!canOwnCompany() && !hasRole(["gerente"])) return toast("Somente gestor/dono ou gerente pode autorizar reabertura.", "danger");
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado.", "danger");
    if (!isFinalStatus(call)) return toast("Este chamado não está finalizado.", "warn");
    const reason = window.prompt("Motivo obrigatório para reabrir o chamado " + (call.protocolo || id) + ":", "Correção autorizada pela gestão");
    if (reason === null) return;
    if (!String(reason || "").trim()) return toast("Informe um motivo para reabrir com auditoria.", "danger");
    await db.collection("calls").doc(id).set({
      status: "Aguardando despacho",
      statusKey: "aguardando_despacho",
      locked: false,
      reopenedAt: new Date().toISOString(),
      reopenedBy: state.user.uid,
      reopenedByEmail: state.user.email,
      reopenReason: reason.trim(),
      billingStatus: call.billingStatus === "recebido" ? "recebido" : "aberto",
      timeline: arrayUnion({ at: new Date().toISOString(), by: personName(), text: "Chamado reaberto com autorização: " + reason.trim() }),
      updatedAt: new Date().toISOString()
    }, { merge: true });
    await db.collection("auditLogs").add({
      collection: "calls",
      docId: id,
      action: "reopen_finalized_call",
      reason: reason.trim(),
      oldData: call,
      userId: state.user.uid,
      userEmail: state.user.email,
      role: state.profile && state.profile.role || "",
      createdAt: new Date().toISOString()
    }).catch(() => {});
    toast("Chamado reaberto com autorização e auditoria.", "ok");
  }

  function editCall(id) {
    if (!canOwnCompany() && !hasRole(["gerente"])) return toast("Somente gestor/dono ou gerente pode editar chamados.", "danger");
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado.", "danger");
    if (isFinalStatus(call) && call.locked !== false) return toast("Chamado finalizado está travado. Reabra com autorização antes de editar.", "danger");
    state.editingCallId = id;
    showView("chamados");
    setValue("callCustomerId", call.customerId || "");
    setValue("callClient", call.cliente || "");
    setValue("callPhone", call.phone || "");
    setValue("callType", call.serviceType || "Guincho");
    setValue("callPrice", call.valor || "");
    setPriceMode(call.priceMode || (call.manualPriceLocked === false ? "suggested" : "manual"), Number(call.valor || 0) > 0 && call.manualPriceLocked !== false);
    setValue("callSource", call.source || "Particular");
    setValue("callPriority", call.priority || "normal");
    setValue("callInsurance", call.insurance || "");
    setValue("callInsuranceProtocol", call.insuranceProtocol || "");
    setValue("callPolicy", call.policy || "");
    setValue("callClaim", call.claimNumber || "");
    setValue("callPolicyNumber", call.policyNumber || "");
    setValue("callSlaLimit", call.slaLimitAt || "");
    setValue("callBillingStatus", call.billingStatus || "aberto");
    setValue("callCustomerPlate", call.customerPlate || "");
    setValue("callCustomerVehicle", call.customerVehicle || "");
    setValue("callExtraKm", call.extraKm || "");
    setValue("callVehicle", call.vehicleId || "");
    setValue("callDriver", call.driverId || "");
    setValue("callNotes", call.notes || "");
    const originPoint = pointFrom(call.origem || call.origin);
    const destPoint = pointFrom(call.destino || call.destination);
    state.addresses.origin = {
      label: call.originLabel || call.origem && call.origem.label || "",
      coords: originPoint,
      source: call.origem && call.origem.source || "edit",
      resolvedAt: call.origem && call.origem.resolvedAt || new Date().toISOString()
    };
    state.addresses.destination = {
      label: call.destLabel || call.destino && call.destino.label || "",
      coords: destPoint,
      source: call.destino && call.destino.source || "edit",
      resolvedAt: call.destino && call.destino.resolvedAt || new Date().toISOString()
    };
    state.addresses.waypoints = Array.isArray(call.routeWaypoints) ? call.routeWaypoints : [];
    setValue("callRouteExternalUrl", call.routeExternalUrl || call.routeUrl || "");
    routeLinkStatus(call.routeExternalUrl ? "Link externo carregado do chamado." : "Sem link externo salvo neste chamado.", call.routeExternalUrl ? "ok" : "muted");
    setTowPricingForm(call.towPricing || call.deslocamentoGuincho || call.guincho || { ativo: false, tipo: "leve", franquiaKm: 15, cobrarIdaVolta: true });
    setValue("callOriginLabel", state.addresses.origin.label);
    setValue("callOriginLat", originPoint && originPoint.lat);
    setValue("callOriginLng", originPoint && originPoint.lng);
    setValue("callDestLabel", state.addresses.destination.label);
    setValue("callDestLat", destPoint && destPoint.lat);
    setValue("callDestLng", destPoint && destPoint.lng);
    state.smartRoute = null;
    state.routePricing = call.pricingSuggestion || call.tollEstimate ? {
      routeMetrics: call.routeMetrics || {},
      tollEstimate: call.tollEstimate || { total: 0, plazas: [], warning: "" },
      pricingSuggestion: call.pricingSuggestion || {
        suggestedServiceValue: Number(call.valor || 0),
        manualValue: Number(call.valor || 0),
        finalValue: Number(call.valor || 0),
        manualPriceLocked: call.manualPriceLocked !== false,
        priceMode: call.priceMode || "manual"
      }
    } : null;
    renderSmartRouteBox();
    renderRoutePricingSummary(state.routePricing);
    setSubmitText("callForm", "Salvar alterações do chamado");
    if ($("callCancelEdit")) $("callCancelEdit").classList.remove("hidden");
    toast("Edite o chamado e salve as alterações.", "ok");
  }

  async function deleteCall(id) {
    if (!canOwnCompany()) return toast("Somente gestor/dono pode excluir chamados.", "danger");
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado.", "danger");
    const label = call.protocolo || call.cliente || id;
    const reason = window.prompt(`Motivo para excluir o chamado ${label}:`, "Cancelamento operacional");
    if (reason === null) return;
    await softDeleteDoc("calls", id, call, reason);
    const linkedTransactions = await db.collection("transactions").where("callId", "==", id).get();
    const batch = db.batch();
    linkedTransactions.forEach((doc) => {
      batch.set(doc.ref, {
        deletedAt: new Date().toISOString(),
        deletedBy: state.user.uid,
        deletedByEmail: state.user.email,
        auditReason: "Vinculado ao chamado excluído: " + reason
      }, { merge: true });
    });
    await batch.commit();
    if (state.editingCallId === id) resetCallForm();
    toast("Chamado removido do painel com auditoria.", "ok");
  }

  async function reviewCallProofs(id) {
    if (!canOwnCompany() && !hasRole(["gerente"])) return toast("Somente gestor/dono ou gerente pode revisar provas.", "danger");
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado.", "danger");
    if (!callProofComplete(call)) return toast("Ainda faltam fotos obrigatórias, checklist ou assinatura/aceite.", "danger");
    await db.collection("calls").doc(id).set({
      proofStatus: "revisado",
      proofReviewedAt: new Date().toISOString(),
      proofReviewedBy: state.user.uid,
      billingStatus: Number(call.valor || 0) > 0 ? "a_faturar" : call.billingStatus || "sem_valor",
      timeline: arrayUnion({ at: new Date().toISOString(), by: personName(), text: "Gestão revisou provas do atendimento para faturamento" })
    }, { merge: true });
    await syncPublicCall(id, { proofStatus: "revisado", billingStatus: Number(call.valor || 0) > 0 ? "a_faturar" : call.billingStatus || "sem_valor" });
    toast("Provas revisadas. Chamado liberado para faturamento.", "ok");
  }

  function viewCallProofs(id) {
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado.", "danger");
    const photos = proofPhotos(call);
    const signature = call.customerSignature || {};
    const checklist = call.proofChecklist || {};
    const damage = call.damageAssessment || checklist.damageAssessment || {};
    const photoBlock = (type) => {
      const photo = proofPhotoByType(photos, type);
      return photo ? `<div class="photo"><b>${esc(proofPhotoLabel(type))}</b><br><img src="${esc(photo.cloudinaryUrl)}"></div>` : `<div class="photo missing"><b>${esc(proofPhotoLabel(type))}</b><br>Foto não enviada.</div>`;
    };
    const photoHtml = photos.length ? photos.map((photo) => `<div class="photo"><b>${esc(photo.label || proofPhotoLabel(photo.type) || "Foto")}</b><br><img src="${esc(photo.cloudinaryUrl)}" alt="${esc(photo.label || proofPhotoLabel(photo.type) || "Foto")}"></div>`).join("") : "<p>Sem fotos.</p>";
    const sigUrl = signature.signatureUrl || signature.cloudinaryUrl || "";
    const sigHtml = sigUrl ? `<p><b>Assinatura:</b> ${esc(signature.name || "")} ${esc(signature.document || "")}<br><b>Aceite:</b> ${esc(signature.acceptedText || "")}</p><img class="signature-img" src="${esc(sigUrl)}" alt="Assinatura">` : signature.refused ? `<p><b>Assinatura não coletada.</b><br><b>Justificativa:</b> ${esc(signature.refusalReason || "")}<br><b>Aceite registrado:</b> ${esc(signature.acceptedText || "")}</p>` : "<p>Sem assinatura.</p>";
    const phaseSignatures = call.phaseSignatures || {};
    const phaseSigHtml = ["retirada", "entrega", "finalizacao"].map((phase) => {
      const item = phaseSignatures[phase] || {};
      const url = item.signatureUrl || item.cloudinaryUrl || "";
      if (url) return `<div class="photo"><b>${esc(PROOF_STAGE_LABELS[phase] || phase)}</b><p>${esc(item.name || "")} ${esc(item.document || "")}<br>${esc(item.acceptedText || "")}</p><img src="${esc(url)}"></div>`;
      if (item.refused) return `<div class="photo missing"><b>${esc(PROOF_STAGE_LABELS[phase] || phase)}</b><p>Sem assinatura. Justificativa: ${esc(item.refusalReason || "")}</p></div>`;
      return `<div class="photo missing"><b>${esc(PROOF_STAGE_LABELS[phase] || phase)}</b><p>Assinatura/justificativa pendente.</p></div>`;
    }).join("");
    const checklistHtml = REQUIRED_PROOF_STAGES.map((stage) => {
      const row = checklist[stage] || {};
      return `<li><b>${esc(PROOF_STAGE_LABELS[stage] || stage)}:</b> ${esc(row.status || "pendente")}${row.justificativa ? `<br><span class="muted">Justificativa: ${esc(row.justificativa)}</span>` : ""}</li>`;
    }).join("");
    const inspection = checklist.vehicleInspection || {};
    const accessoryRows = Array.isArray(inspection.accessories) ? inspection.accessories.flatMap((group) => (group.items || []).map((item) => ({
      group: group.title || "",
      label: item.label || item.key || "",
      value: item.shortLabel || item.value || ""
    }))).filter((item) => item.value) : [];
    const inspectionHtml = `<h2>Ficha técnica e acessórios</h2>
      <div class="report-context">
        <div><b>Combustível</b><br>${esc(inspection.fuelLevel || "-")}</div>
        <div><b>Odômetro</b><br>${esc(inspection.odometer || "-")}</div>
        <div><b>Pneus</b><br>${esc(inspection.tireCondition || "-")}</div>
        <div><b>Chave/documento</b><br>${esc(inspection.keyDocument || "-")}</div>
        <div><b>Veículo carregado</b><br>${esc(inspection.vehicleLoaded || "-")}</div>
        <div><b>Fácil remoção</b><br>${esc(inspection.easyRemoval || "-")}</div>
      </div>
      <p><b>Responsável retirada:</b> ${esc(inspection.pickupResponsible && inspection.pickupResponsible.name || "-")} ${esc(inspection.pickupResponsible && inspection.pickupResponsible.document || "")}<br>
      <b>Responsável entrega:</b> ${esc(inspection.deliveryResponsible && inspection.deliveryResponsible.name || "-")} ${esc(inspection.deliveryResponsible && inspection.deliveryResponsible.document || "")}</p>
      ${inspection.technicalNotes ? `<p><b>Observações técnicas:</b><br>${esc(inspection.technicalNotes)}</p>` : ""}
      ${accessoryRows.length ? `<table><thead><tr><th>Grupo</th><th>Item</th><th>S/N/A</th></tr></thead><tbody>${accessoryRows.map((item) => `<tr><td>${esc(item.group)}</td><td>${esc(item.label)}</td><td>${esc(item.value)}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">Sem acessórios marcados.</p>`}`;
    const stageEvidenceHtml = `
      <section><h2>Antes do carregamento</h2><div class="grid">${["front", "rear", "right", "left", "dashboard"].map(photoBlock).join("")}</div><p>${esc(checklist.retirada && checklist.retirada.justificativa || "")}</p></section>
      <section><h2>Carregado no caminhão</h2><div class="grid">${photoBlock("load_after")}</div><p>${esc(checklist.carregamento && checklist.carregamento.justificativa || "")}</p></section>
      <section><h2>Depois da descarga / entrega</h2><div class="grid">${["delivery_front", "delivery_rear", "delivery_right", "delivery_left", "delivery_dashboard", "final"].map(photoBlock).join("")}</div><p>${esc(checklist.entrega && checklist.entrega.justificativa || "")}</p></section>
    `;
    const damageParts = Array.isArray(damage.parts) ? damage.parts.map((part) => part.label || part.key).filter(Boolean).join(", ") : "";
    const damageHtml = `<h2>Avarias marcadas</h2><p><b>Tipo:</b> ${esc(damage.vehicleType || "-")}<br><b>Partes:</b> ${esc(damageParts || "-")}<br><b>Descrição:</b><br>${esc(damage.details || "-")}</p>`;
    const company = cfg.empresa || {};
    const headerHtml = `<header class="report-header"><div><h1>Laudo técnico de atendimento</h1><p class="muted">${esc(company.nome || "JM Guinchos")} · ${esc(company.cidadeBase || "")} · ${esc(company.telefoneOperacional || "")}</p></div><div class="report-stamp"><b>${esc(call.protocolo || id)}</b><span>${dateTime(new Date().toISOString())}</span></div></header>`;
    const win = window.open("", "_blank");
    if (!win) return toast("O navegador bloqueou a janela de provas.", "danger");
    win.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Laudo ${esc(call.protocolo || id)}</title><style>body{font-family:Arial,sans-serif;padding:18px;color:#111827}.report-header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:2px solid #0f766e;padding-bottom:12px;margin-bottom:14px}.report-header h1{margin:0 0 4px;font-size:24px}.report-stamp{text-align:right;border:1px solid #d1d5db;border-radius:8px;padding:10px;min-width:160px}.report-stamp span{display:block;color:#64748b;font-size:12px;margin-top:4px}h2{font-size:15px;margin:18px 0 8px;color:#0f766e}.muted{color:#64748b}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.photo{break-inside:avoid;border:1px solid #d1d5db;border-radius:8px;padding:8px;margin:6px 0;background:#fff}.photo img{width:100%;height:118px;object-fit:cover;object-position:center;margin-top:6px;border-radius:6px}.signature-img,.photo .signature-img{width:100%;max-width:360px;height:92px;object-fit:contain;background:#fff;border:1px solid #d1d5db;border-radius:6px}.missing{color:#991b1b;background:#fef2f2}.report-context{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.report-context div{border:1px solid #e5e7eb;border-radius:8px;padding:8px}table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #e5e7eb;padding:6px;text-align:left;font-size:12px}@media print{button{display:none}.photo{page-break-inside:avoid}.grid{grid-template-columns:repeat(4,minmax(0,1fr))}.photo img{height:92px}.signature-img{height:82px}body{padding:8mm}.report-header{position:running(reportHeader)}}@page{margin:10mm}</style></head><body>${headerHtml}<div class="report-context"><div><b>Cliente</b><br>${esc(call.cliente || "-")}</div><div><b>Seguradora</b><br>${esc(call.insurance || call.source || "-")}</div><div><b>Placa</b><br>${esc(call.customerPlate || "-")}</div></div><h2>Checklist por etapa</h2><ul>${checklistHtml}</ul><p>${esc(checklist.notes || "")}</p>${inspectionHtml}${damageHtml}${stageEvidenceHtml}<h2>Assinatura ou justificativa por fase</h2><div class="grid">${phaseSigHtml}</div><h2>Assinatura geral de compatibilidade</h2>${sigHtml}<h2>Fotos gerais</h2>${photoHtml}${SYSTEM_SIGNATURE ? `<p class="muted">${SYSTEM_SIGNATURE}</p>` : ""}</body></html>`);
    win.document.close();
  }

  function publicStatusLabel(call) {
    const key = statusKey(call);
    const labels = {
      aguardando_despacho: "Atendimento recebido",
      despachado: "Guincho em preparação",
      motorista_a_caminho: "Motorista a caminho",
      motorista_no_local: "Motorista chegou ao local",
      veiculo_carregado: "Veículo carregado",
      em_transporte: "Veículo em remoção/transporte",
      entregue: "Veículo entregue",
      finalizado: "Atendimento finalizado",
      cancelado: "Atendimento cancelado"
    };
    return labels[key] || "Atendimento recebido";
  }

  function publicToken() {
    const bytes = new Uint8Array(18);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function publicClientUrl(token) {
    return location.origin + location.pathname.replace(/jm\.html.*$/i, "cliente-chamado.html") + "?t=" + encodeURIComponent(token);
  }

  function publicReportUrl(token) {
    return location.origin + location.pathname.replace(/jm\.html.*$/i, "relatorio.html") + "?t=" + encodeURIComponent(token);
  }

  function publicTimeline(call) {
    const rows = Array.isArray(call.timeline) ? call.timeline : [];
    return rows.slice(-20).map((event) => ({
      at: event.at || event.dt || "",
      status: event.status || publicStatusLabel(call),
      text: event.publicText || event.text || event.acao || "",
      by: event.by || "JM Guinchos"
    }));
  }

  function publicProofs(call) {
    if (!call.publicProofsEnabled) return [];
    return proofPhotos(call).filter((photo) => {
      const visibility = String(photo.visibility || "").toLowerCase();
      return photo.approvedForClient === true || ["client", "public"].includes(visibility) || call.publicProofsEnabled === true;
    }).map((photo) => ({
      label: photo.label || photo.type || "Foto",
      url: photo.cloudinaryUrl,
      type: photo.type || "",
      uploadedAt: photo.uploadedAt || ""
    }));
  }

  function publicCallPayload(call) {
    const driver = state.users[call.driverId] || {};
    const vehicle = state.vehicles[call.vehicleId] || {};
    const token = call.publicToken || publicToken();
    return {
      publicToken: token,
      callId: call.id,
      companyName: "JM Guinchos",
      statusPublic: publicStatusLabel(call),
      statusKey: statusKey(call),
      serviceType: call.serviceType || call.tipo || "Guincho",
      clientNameMasked: call.cliente || call.customerName || "Cliente",
      customerPhone: call.publicChatEnabled ? (call.phone || "") : "",
      vehiclePlateMasked: call.customerPlate || "",
      customerVehicle: call.customerVehicle || "",
      originLabel: call.publicRouteEnabled !== false ? (call.originLabel || call.origem && call.origem.label || "") : "",
      destinationLabel: call.publicRouteEnabled !== false ? (call.destLabel || call.destino && call.destino.label || "") : "",
      driverName: call.publicDriverEnabled !== false ? (driver.nome || driver.email || "") : "",
      fleetVehicle: call.publicDriverEnabled !== false ? (vehicle.placa || vehicle.apelido || "") : "",
      timelinePublic: publicTimeline(call),
      proofsPublic: publicProofs(call),
      damageAssessmentPublic: call.publicProofsEnabled ? (call.damageAssessment || call.proofChecklist && call.proofChecklist.damageAssessment || null) : null,
      vehicleInspectionPublic: call.publicProofsEnabled ? (call.proofChecklist && call.proofChecklist.vehicleInspection || null) : null,
      customerSignaturePublic: call.publicProofsEnabled ? (call.customerSignature || null) : null,
      phaseSignaturesPublic: call.publicProofsEnabled ? (call.phaseSignatures || {}) : {},
      reportEnabled: call.publicReportEnabled !== false,
      chatEnabled: call.publicChatEnabled !== false,
      paymentNegotiationEnabled: call.publicPaymentNegotiationEnabled === true,
      paymentStatus: call.publicPaymentNegotiationEnabled ? (call.billingStatus || "") : "",
      amountDue: call.publicPaymentNegotiationEnabled ? Number(call.financialSummary && call.financialSummary.balanceAmount || call.valor || 0) : 0,
      whatsapp: (state.settings.company && state.settings.company.telefoneOperacional) || cfg.empresa && cfg.empresa.telefoneOperacional || "",
      updatedAt: new Date().toISOString(),
      revoked: call.publicRevoked === true,
      expiresAt: call.publicTokenExpiresAt || ""
    };
  }

  async function syncPublicCall(callId, extra) {
    const call = Object.assign({}, state.calls[callId] || {});
    Object.entries(extra || {}).forEach(([key, value]) => {
      if (key === "timeline" && !Array.isArray(value)) return;
      call[key] = value;
    });
    if (!call || !call.publicToken || call.publicRevoked) return;
    await db.collection("publicCalls").doc(call.publicToken).set(publicCallPayload(call), { merge: true });
  }

  async function generatePublicLink(id) {
    if (!canOperateCalls()) return toast("Sem permissão para gerar link público.", "danger");
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado.", "danger");
    const token = call.publicToken || publicToken();
    const updates = {
      publicTrackingEnabled: true,
      publicToken: token,
      publicTokenCreatedAt: call.publicTokenCreatedAt || new Date().toISOString(),
      publicRevoked: false,
      publicChatEnabled: call.publicChatEnabled !== false,
      publicReportEnabled: call.publicReportEnabled !== false,
      publicRouteEnabled: call.publicRouteEnabled !== false,
      publicDriverEnabled: call.publicDriverEnabled !== false,
      updatedAt: new Date().toISOString()
    };
    await db.collection("calls").doc(id).set(updates, { merge: true });
    await db.collection("publicCalls").doc(token).set(publicCallPayload(Object.assign({}, call, updates)), { merge: true });
    toast("Link público do cliente gerado.", "ok");
    try { await navigator.clipboard.writeText(publicClientUrl(token)); } catch (_) {}
  }

  async function copyPublicLink(id) {
    const call = state.calls[id];
    if (!call || !call.publicToken || call.publicRevoked) return toast("Gere o link público antes de copiar.", "danger");
    const url = publicClientUrl(call.publicToken);
    try {
      await navigator.clipboard.writeText(url);
      toast("Link do cliente copiado.", "ok");
    } catch (_) {
      window.prompt("Copie o link do cliente:", url);
    }
  }

  function openPublicView(id) {
    const call = state.calls[id];
    if (!call || !call.publicToken || call.publicRevoked) return toast("Gere o link público antes de abrir.", "danger");
    window.open(publicClientUrl(call.publicToken), "_blank");
  }

  async function revokePublicLink(id) {
    if (!canOwnCompany() && !hasRole(["gerente"])) return toast("Somente gestor/dono ou gerente pode revogar link público.", "danger");
    const call = state.calls[id];
    if (!call || !call.publicToken) return toast("Chamado sem link público.", "danger");
    await db.collection("calls").doc(id).set({ publicRevoked: true, publicTrackingEnabled: false, updatedAt: new Date().toISOString() }, { merge: true });
    await db.collection("publicCalls").doc(call.publicToken).set({ revoked: true, updatedAt: new Date().toISOString() }, { merge: true });
    toast("Link público revogado.", "ok");
  }

  async function togglePublicProofs(id) {
    if (!canOwnCompany() && !hasRole(["gerente"])) return toast("Somente gestor/dono ou gerente pode liberar provas ao cliente.", "danger");
    const call = state.calls[id];
    if (!call) return;
    const enabled = !call.publicProofsEnabled;
    await db.collection("calls").doc(id).set({ publicProofsEnabled: enabled, updatedAt: new Date().toISOString() }, { merge: true });
    await syncPublicCall(id, { publicProofsEnabled: enabled });
    toast(enabled ? "Provas liberadas para o cliente." : "Provas bloqueadas para o cliente.", enabled ? "ok" : "warn");
  }

  async function togglePublicPayment(id) {
    if (!canManageFinance()) return toast("Somente gestor/dono ou financeiro pode liberar negociação de pagamento.", "danger");
    const call = state.calls[id];
    if (!call) return;
    const enabled = !call.publicPaymentNegotiationEnabled;
    await db.collection("calls").doc(id).set({ publicPaymentNegotiationEnabled: enabled, updatedAt: new Date().toISOString() }, { merge: true });
    await syncPublicCall(id, { publicPaymentNegotiationEnabled: enabled });
    toast(enabled ? "Negociação de pagamento habilitada no link público." : "Negociação de pagamento desabilitada.", enabled ? "ok" : "warn");
  }

  function openReport(id) {
    const call = state.calls[id];
    if (call && call.publicToken && !call.publicRevoked) return window.open(publicReportUrl(call.publicToken), "_blank");
    return viewCallProofs(id);
  }

  async function replyPublicChat(id) {
    if (!canOperateCalls()) return toast("Sem permissão para responder cliente.", "danger");
    const call = state.calls[id];
    if (!call || !call.publicToken || call.publicRevoked) return toast("Gere um link público ativo antes de abrir o chat.", "danger");
    const field = $("publicChatReply_" + id);
    const text = field && field.value || window.prompt("Mensagem para o cliente:");
    if (!text || !text.trim()) return;
    await db.collection("publicCalls").doc(call.publicToken).collection("messages").add({
      senderType: "admin",
      senderName: personName(),
      message: text.trim(),
      createdAt: new Date().toISOString(),
      callId: id
    });
    if (field) field.value = "";
    await markPublicChatRead(id, false);
    toast("Mensagem enviada ao cliente.", "ok");
  }

  async function markPublicChatRead(id, showToast) {
    const call = state.calls[id];
    if (!call || !call.publicToken) return;
    const rows = (state.publicChatMessages[call.publicToken] || []).filter((msg) => msg.senderType === "client" && !msg.readAt);
    const now = new Date().toISOString();
    await Promise.all(rows.map((msg) => db.collection("publicCalls").doc(call.publicToken).collection("messages").doc(msg.id).set({
      readAt: now,
      readBy: state.user.uid,
      readByName: personName()
    }, { merge: true })));
    if (showToast !== false) toast("Mensagens do cliente marcadas como lidas.", "ok");
  }

  function renderCallDossier() {
    const box = $("callDossierBox");
    if (!box) return;
    const call = state.calls[state.selectedDossierCallId] || visibleRows(state.calls).find((c) => !isFinalStatus(c)) || null;
    if (!call) {
      box.innerHTML = `<p class="muted">Selecione um chamado para ver checklist, fotos, assinatura, rota, financeiro e auditoria operacional.</p>`;
      return;
    }
    state.selectedDossierCallId = call.id;
    const vehicle = state.vehicles[call.vehicleId] || {};
    const driver = state.users[call.driverId] || {};
    const checklist = call.proofChecklist || {};
    const photos = proofPhotos(call);
    const sig = call.customerSignature || {};
    const sigUrl = sig.signatureUrl || sig.cloudinaryUrl || "";
    const txs = visibleRows(state.transactions).filter((t) => t.callId === call.id);
    const entradas = txs.filter((t) => t.type === "entrada").reduce((s, t) => s + Number(t.amount || 0), 0);
    const saidas = txs.filter((t) => t.type === "saida").reduce((s, t) => s + Number(t.amount || 0), 0);
    const checklistHtml = REQUIRED_PROOF_STAGES.map((stage) => {
      const row = checklist[stage] || {};
      return `<div class="dossier-row"><b>${esc(PROOF_STAGE_LABELS[stage] || stage)}</b><span class="badge ${row.status && row.status !== "pendente" ? "ok" : "warn"}">${esc(row.status || "pendente")}</span>${row.justificativa ? `<small>${esc(row.justificativa)}</small>` : ""}</div>`;
    }).join("");
    const damage = call.damageAssessment || checklist.damageAssessment || {};
    const damageParts = Array.isArray(damage.parts) ? damage.parts.map((part) => part.label || part.key).filter(Boolean).join(", ") : "";
    const damageHtml = damageParts || damage.details ? `<div class="dossier-row"><b>Avarias no desenho</b><small>${esc(damage.vehicleType || "veículo")}</small><span>${esc(damageParts || "sem partes marcadas")}</span>${damage.details ? `<small>${esc(damage.details)}</small>` : ""}</div>` : `<p class="muted small">Nenhuma avaria marcada no desenho.</p>`;
    const photosHtml = photos.length ? photos.map((p) => `<a class="proof-thumb" target="_blank" rel="noopener noreferrer" href="${esc(p.cloudinaryUrl)}"><img src="${esc(p.cloudinaryUrl)}" alt="${esc(p.label || proofPhotoLabel(p.type) || "foto")}"><span>${esc(p.label || proofPhotoLabel(p.type) || "foto")}</span></a>`).join("") : `<p class="muted small">Sem fotos salvas.</p>`;
    const beforeAfterHtml = `
      <div class="proof-stage-evidence"><h4>Antes do carregamento</h4><div class="proof-thumbs">${["front", "rear", "right", "left", "dashboard"].map((type) => {
        const p = proofPhotoByType(photos, type);
        return p ? `<a class="proof-thumb" target="_blank" rel="noopener noreferrer" href="${esc(p.cloudinaryUrl)}"><img src="${esc(p.cloudinaryUrl)}" alt="${esc(proofPhotoLabel(type))}"><span>${esc(proofPhotoLabel(type))}</span></a>` : `<div class="proof-thumb missing"><span>${esc(proofPhotoLabel(type))}: pendente</span></div>`;
      }).join("")}</div></div>
      <div class="proof-stage-evidence"><h4>Carregado no caminhão</h4><div class="proof-thumbs">${["load_after"].map((type) => {
        const p = proofPhotoByType(photos, type);
        return p ? `<a class="proof-thumb" target="_blank" rel="noopener noreferrer" href="${esc(p.cloudinaryUrl)}"><img src="${esc(p.cloudinaryUrl)}" alt="${esc(proofPhotoLabel(type))}"><span>${esc(proofPhotoLabel(type))}</span></a>` : `<div class="proof-thumb missing"><span>${esc(proofPhotoLabel(type))}: pendente</span></div>`;
      }).join("")}</div></div>
      <div class="proof-stage-evidence"><h4>Entrega / depois de descarregar</h4><div class="proof-thumbs">${["delivery_front", "delivery_rear", "delivery_right", "delivery_left", "delivery_dashboard", "final"].map((type) => {
        const p = proofPhotoByType(photos, type);
        return p ? `<a class="proof-thumb" target="_blank" rel="noopener noreferrer" href="${esc(p.cloudinaryUrl)}"><img src="${esc(p.cloudinaryUrl)}" alt="${esc(proofPhotoLabel(type))}"><span>${esc(proofPhotoLabel(type))}</span></a>` : `<div class="proof-thumb missing"><span>${esc(proofPhotoLabel(type))}: pendente</span></div>`;
      }).join("")}</div></div>`;
    const timeline = (call.timeline || []).slice().reverse().slice(0, 8).map((t) => `<div class="timeline-item"><b>${esc(t.by || t.user || "Sistema")}</b><br>${esc(t.text || t.acao || "")}<br><small>${dateTime(t.at || t.dt)}</small></div>`).join("") || `<p class="muted small">Sem auditoria operacional.</p>`;
    const tow = call.towPricing || call.deslocamentoGuincho || {};
    const towText = tow.ativo
      ? `<p class="small"><b>${esc(tow.tipoLabel || tow.tipo || "Guincho")}</b><br>KM ida: <b>${esc(String(tow.kmTotal || tow.kmIda || 0).replace(".", ","))}</b> · KM cobrado: <b>${esc(String(tow.kmCobradoTotal ?? tow.kmCobrado ?? 0).replace(".", ","))}</b> · Franquia: <b>${esc(String(tow.franquiaKm || 0).replace(".", ","))}</b><br>Saída: <b>${money(tow.valorSaida || 0)}</b> · KM: <b>${money(tow.valorKmAdicional || 0)}</b> · Desc.: <b>${esc(String(tow.descontoPct || 0).replace(".", ","))}%</b><br>Pedágios: <b>${money(tow.pedagioTotal || tow.valorPedagios || 0)}</b> · Total guincho: <b>${money(tow.total || 0)}</b>${tow.obs ? "<br>Obs.: " + esc(tow.obs) : ""}</p>`
      : `<p class="muted small">Sem precificação de guincho vinculada.</p>`;
    const pricing = call.pricingSuggestion || {};
    const tollEstimate = call.tollEstimate || {};
    const tollRows = Array.isArray(tollEstimate.plazas) && tollEstimate.plazas.length
      ? tollEstimate.plazas.map((p) => `<li>${esc(p.name || p.id)} ${p.road ? " - " + esc(p.road) : ""}: <b>${money(p.amount || 0)}</b> <span class="muted">(${esc(String(p.distanceFromRouteMeters || 0))}m)</span></li>`).join("")
      : "<li>Nenhuma praca cadastrada detectada.</li>";
    const cost = call.costEstimate || {};
    const costText = canSeeSensitiveFinance() && cost.totalEstimatedCost != null
      ? `<br>Custo estimado: <b>${money(cost.totalEstimatedCost || 0)}</b> · Lucro previsto: <b>${money(cost.expectedProfit || 0)}</b>`
      : "";
    const routePricingText = pricing.suggestedServiceValue
      ? `<p class="small">Distancia: <b>${esc(String(pricing.distanceKm || 0).replace(".", ","))} km</b><br>Valor oficial: <b>${money(pricing.finalValue || call.valor || 0)}</b><br>Preco sugerido: <b>${money(pricing.suggestedServiceValue || 0)}</b><br>Valor manual: <b>${pricing.manualPriceLocked ? money(pricing.manualValue || 0) : "nao travado"}</b><br>Pedagio estimado: <b>${money(tollEstimate.total || pricing.tollTotal || 0)}</b>${costText}<br><span class="muted">${esc(tollEstimate.warning || "")}</span></p><ul class="route-pricing-tolls">${tollRows}</ul>`
      : `<p class="muted small">Sem sugestao de rota/preco salva.</p>`;
    const publicActive = call.publicToken && !call.publicRevoked;
    const publicLink = publicActive ? publicClientUrl(call.publicToken) : "";
    const chatRows = publicActive ? (state.publicChatMessages[call.publicToken] || []) : [];
    const unreadChat = publicChatUnreadCount(call);
    const chatPreview = publicActive
      ? `<div class="public-chat-admin">
          <div class="actions" style="justify-content:space-between">
            <b>Chat com o cliente</b>
            <span class="badge ${unreadChat ? "danger" : "ok"}">${unreadChat ? unreadChat + " não lida(s)" : "em dia"}</span>
          </div>
          <div class="chat-messages compact">${chatRows.length ? chatRows.slice(-8).map((msg) => `<div class="chat-message ${esc(msg.senderType || "client")}"><b>${esc(msg.senderName || (msg.senderType === "admin" ? "JM Guinchos" : "Cliente"))}</b><br>${esc(msg.message || "")}<br><small>${dateTime(msg.createdAt)}${msg.senderType === "client" && !msg.readAt ? " · não lida" : ""}</small></div>`).join("") : `<p class="muted small">Nenhuma mensagem do cliente ainda.</p>`}</div>
          <textarea id="publicChatReply_${esc(call.id)}" placeholder="Responder cliente pelo link público"></textarea>
          <div class="actions">
            <button class="btn primary" onclick="JM.app.replyPublicChat('${esc(call.id)}')">Enviar resposta</button>
            <button class="btn" onclick="JM.app.markPublicChatRead('${esc(call.id)}')">Marcar como lidas</button>
          </div>
        </div>`
      : `<p class="muted small">Gere o link público para habilitar chat e alertas de mensagens.</p>`;
    const publicHtml = `<div class="public-link-box">
      <b>Link público do cliente</b><br>
      <span class="badge ${publicActive ? "ok" : "muted"}">${publicActive ? "Ativo" : call.publicRevoked ? "Revogado" : "Não gerado"}</span>
      ${unreadChat ? `<span class="badge danger">${unreadChat} mensagem(ns) do cliente</span>` : ""}
      ${call.publicProofsEnabled ? '<span class="badge ok">Provas liberadas</span>' : '<span class="badge warn">Provas internas</span>'}
      ${call.publicPaymentNegotiationEnabled ? '<span class="badge info">Pagamento habilitado</span>' : ''}
      <p class="small">${publicLink ? esc(publicLink) : "Gere um token para enviar ao cliente final sem expor o painel interno."}</p>
      <div class="actions">
        <button class="btn primary" onclick="JM.app.generatePublicLink('${esc(call.id)}')">Gerar link</button>
        <button class="btn" onclick="JM.app.copyPublicLink('${esc(call.id)}')">Copiar link</button>
        <button class="btn" onclick="JM.app.openPublicView('${esc(call.id)}')">Abrir visão</button>
        <button class="btn" onclick="JM.app.togglePublicProofs('${esc(call.id)}')">${call.publicProofsEnabled ? "Bloquear provas" : "Liberar provas"}</button>
        <button class="btn" onclick="JM.app.replyPublicChat('${esc(call.id)}')">Abrir chat</button>
        <button class="btn" onclick="JM.app.openReport('${esc(call.id)}')">Relatório/PDF</button>
        ${canManageFinance() ? `<button class="btn" onclick="JM.app.togglePublicPayment('${esc(call.id)}')">${call.publicPaymentNegotiationEnabled ? "Desabilitar pagamento" : "Habilitar negociação"}</button>` : ""}
        ${publicActive ? `<button class="btn danger" onclick="JM.app.revokePublicLink('${esc(call.id)}')">Revogar link</button>` : ""}
      </div>
      ${chatPreview}
    </div>`;
    box.innerHTML = `
      <div class="dossier-head">
        <div><h3>${esc(call.protocolo || call.id)} · ${esc(call.cliente || "")}</h3><p class="muted small">${esc(call.insurance || call.source || "Particular")} ${call.insuranceProtocol ? "· Prot. " + esc(call.insuranceProtocol) : ""} · ${esc(call.customerPlate || "")}</p></div>
        <div class="actions"><span class="badge ${statusClass(call)}">${esc(operationalStatus(call))}</span>${proofStatusBadge(call)}<button class="btn" onclick="JM.app.viewCallProofs('${esc(call.id)}')">Abrir provas</button>${isFinalStatus(call) && (canOwnCompany() || hasRole(["gerente"])) ? `<button class="btn warn" onclick="JM.app.reopenCall('${esc(call.id)}')">Reabrir com autorização</button>` : ""}</div>
      </div>
      <div class="dossier-grid">
        <section><h3>Operação</h3><p class="small"><b>Origem:</b> ${esc(call.originLabel || call.origem && call.origem.label || "-")}<br><b>Destino:</b> ${esc(call.destLabel || call.destino && call.destino.label || "-")}<br><b>Veículo:</b> ${esc(vehicle.placa || call.vehicleId || "-")}<br><b>Motorista:</b> ${esc(driver.nome || driver.email || "-")}</p></section>
        <section class="wide"><h3>Rota interna do chamado</h3><div id="callDossierRouteMap" class="map mini-map"></div></section>
        <section><h3>Precificação do guincho</h3>${towText}</section>
        <section><h3>Rota, pedagio e preco sugerido</h3>${routePricingText}</section>
        <section><h3>Checklist</h3>${checklistHtml}<p class="muted small">${esc(checklist.notes || "")}</p></section>
        <section><h3>Mapa de avarias</h3>${damageHtml}</section>
        <section class="wide"><h3>Antes e depois por etapa</h3>${beforeAfterHtml}</section>
        <section><h3>Fotos</h3><div class="proof-thumbs">${photosHtml}</div></section>
        <section><h3>Assinatura</h3>${sigUrl ? `<p class="small"><b>${esc(sig.name || "Cliente")}</b><br>${esc(sig.document || "")}<br>${dateTime(sig.signedAt)}</p><img class="signature-preview" src="${esc(sigUrl)}" alt="Assinatura">` : sig.refused ? `<p class="small"><b>Sem assinatura</b><br>Justificativa: ${esc(sig.refusalReason || "")}</p>` : `<p class="muted small">Sem assinatura.</p>`}</section>
        <section><h3>Financeiro</h3><p class="small">Cobrança: <b>${esc(call.billingStatus || "aberto")}</b><br>Valor previsto: <b>${canSeeSensitiveFinance() ? money(call.valor || 0) : "Restrito"}</b><br>Resultado lançado: <b>${canSeeSensitiveFinance() ? money(entradas - saidas) : "Restrito"}</b></p></section>
        <section><h3>Linha do tempo</h3>${timeline}</section>
        <section><h3>Cliente final</h3>${publicHtml}</section>
      </div>`;
    setTimeout(() => {
      try {
        window.JM.mapa.renderFleetMap("callDossierRouteMap", state.vehicles, { [call.id]: call }, { selectedCallId: call.id, selectedVehicleId: call.vehicleId, filter: "todos" });
      } catch (err) {
        console.warn("Falha ao renderizar rota interna do chamado", err);
      }
    }, 80);
  }

  function renderCustomers() {
    if (!$("customersTable")) return;
    const rows = visibleRows(state.customers).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    $("customersTable").innerHTML = rows.length ? `<table><thead><tr><th>Cliente</th><th>Tipo</th><th>Contato</th><th>Faturamento</th><th>Ações</th></tr></thead><tbody>` + rows.map((c) => {
      const wa = phoneWhatsappUrl(c.phone, "JM Guinchos");
      return `<tr>
        <td><b>${esc(c.name || c.razaoSocial || c.id)}</b><br><span class="muted small">${esc(c.document || "")}</span></td>
        <td>${esc(c.type || "")}<br><span class="muted small">${esc(c.portalUrl || "")}</span></td>
        <td>${esc(c.contactName || "")}<br><span class="muted small">${esc(c.phone || "")} ${wa ? `· <a class="info" target="_blank" rel="noopener noreferrer" href="${esc(wa)}">WhatsApp</a>` : ""}</span><br><span class="muted small">${esc(c.email || "")}</span></td>
        <td>${esc(c.paymentTerm || "")}<br><span class="badge ${c.glosaRisk === "alto" ? "danger" : c.glosaRisk === "medio" ? "warn" : "ok"}">Glosa ${esc(c.glosaRisk || "baixo")}</span><br><span class="muted small">${esc(c.billingRules || "")}</span><br><span class="muted small">${esc(c.proofRules || "")}</span></td>
        <td class="row-actions"><button class="btn" onclick="JM.app.editCustomer('${esc(c.id)}')">Editar</button><button class="btn danger" onclick="JM.app.deleteCustomer('${esc(c.id)}')">Excluir</button></td>
      </tr>`;
    }).join("") + `</tbody></table>` : `<p class="muted">Cadastre clientes particulares, empresas, seguradoras e assistências para vincular chamados e pagamentos.</p>`;
  }

  $("customerForm") && ($("customerForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!isOffice()) return toast("Sem permissão para cadastrar clientes.", "danger");
    const now = new Date().toISOString();
    const payload = {
      name: $("customerName").value.trim(),
      type: $("customerType").value,
      document: $("customerDocument").value.trim(),
      contactName: $("customerContact").value.trim(),
      phone: $("customerPhone").value.trim(),
      email: $("customerEmail").value.trim(),
      portalUrl: $("customerPortal").value.trim(),
      billingPhone: $("customerBillingPhone").value.trim(),
      billingEmail: $("customerBillingEmail") ? $("customerBillingEmail").value.trim() : "",
      paymentTerm: $("customerPaymentTerm").value.trim(),
      glosaRisk: $("customerGlosaRisk") ? $("customerGlosaRisk").value : "baixo",
      billingRules: $("customerBillingRules").value.trim(),
      proofRules: $("customerProofRules") ? $("customerProofRules").value.trim() : "",
      updatedAt: now,
      updatedBy: state.user.uid
    };
    if (!payload.name) return toast("Informe o nome do cliente/seguradora.", "danger");
    if (state.editingCustomerId) {
      await db.collection("customers").doc(state.editingCustomerId).set(payload, { merge: true });
      toast("Cliente atualizado.", "ok");
    } else {
      await db.collection("customers").add(Object.assign({ createdAt: now, createdBy: state.user.uid }, payload));
      toast("Cliente cadastrado.", "ok");
    }
    resetCustomerForm();
  });

  function editCustomer(id) {
    const c = state.customers[id];
    if (!c) return toast("Cliente não encontrado.", "danger");
    state.editingCustomerId = id;
    showView("clientes");
    setValue("customerName", c.name || "");
    setValue("customerType", c.type || "Particular");
    setValue("customerDocument", c.document || "");
    setValue("customerContact", c.contactName || "");
    setValue("customerPhone", c.phone || "");
    setValue("customerEmail", c.email || "");
    setValue("customerPortal", c.portalUrl || "");
    setValue("customerBillingPhone", c.billingPhone || "");
    setValue("customerBillingEmail", c.billingEmail || "");
    setValue("customerPaymentTerm", c.paymentTerm || "");
    setValue("customerGlosaRisk", c.glosaRisk || "baixo");
    setValue("customerBillingRules", c.billingRules || "");
    setValue("customerProofRules", c.proofRules || "");
    setSubmitText("customerForm", "Salvar alterações do cliente");
    if ($("customerCancelEdit")) $("customerCancelEdit").classList.remove("hidden");
  }

  async function deleteCustomer(id) {
    if (!canOwnCompany()) return toast("Somente gestor/dono pode excluir cliente.", "danger");
    const c = state.customers[id];
    if (!c) return;
    const reason = window.prompt("Motivo para excluir/desativar cliente:", "Cadastro duplicado ou inativo");
    if (reason === null) return;
    await softDeleteDoc("customers", id, c, reason);
    if (state.editingCustomerId === id) resetCustomerForm();
    toast("Cliente removido do painel com auditoria.", "ok");
  }

  function renderIntegrationInbox() {
    if (!$("integrationInboxTable")) return;
    const rows = visibleRows(state.integrationInbox).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    $("integrationInboxTable").innerHTML = rows.length ? `<table><thead><tr><th>Origem</th><th>Protocolo</th><th>Cliente</th><th>Status</th><th>Ações</th></tr></thead><tbody>` + rows.map((row) => `<tr>
      <td><b>${esc(row.sourceName || row.source || "Integração")}</b><br><span class="muted small">${esc(row.sourceType || "manual")} · ${dateTime(row.createdAt)}</span></td>
      <td>${esc(row.protocol || row.externalId || "")}<br><span class="muted small">${esc(row.externalId || "")}</span></td>
      <td>${esc(row.customerName || "")}<br><span class="muted small">${esc(row.customerPhone || "")}</span></td>
      <td><span class="badge ${row.status === "convertido" ? "ok" : row.status === "erro" ? "danger" : "warn"}">${esc(row.status || "novo")}</span></td>
      <td class="row-actions"><button class="btn good" onclick="JM.app.applyIntegrationToCall('${esc(row.id)}')">Gerar chamado</button><button class="btn" onclick="JM.app.markIntegrationHandled('${esc(row.id)}')">Marcar tratado</button></td>
    </tr>`).join("") + `</tbody></table>` : `<p class="muted">Sem acionamentos externos na fila. A integração real entra aqui por webhook, e-mail parser ou robô autorizado.</p>`;
  }

  $("integrationForm") && ($("integrationForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!canOperateCalls()) return toast("Sem permissão para registrar acionamento externo.", "danger");
    const normalizedCall = {
      source: "Seguradora",
      insurance: $("intSource").value.trim(),
      insuranceProtocol: $("intProtocol").value.trim(),
      claimNumber: $("intClaim") ? $("intClaim").value.trim() : "",
      policyNumber: $("intPolicy") ? $("intPolicy").value.trim() : "",
      customerName: $("intCustomer").value.trim(),
      customerPhone: $("intPhone").value.trim(),
      customerPlate: $("intPlate") ? $("intPlate").value.trim().toUpperCase() : "",
      originText: $("intOrigin") ? $("intOrigin").value.trim() : "",
      destinationText: $("intDestination") ? $("intDestination").value.trim() : "",
      slaLimitAt: $("intSla") ? $("intSla").value : "",
      rawText: $("intPayload").value.trim()
    };
    await db.collection("integrationInbox").add({
      source: $("intSource").value.trim(),
      sourceName: $("intSource").value.trim(),
      sourceType: $("intSourceType") ? $("intSourceType").value : "manual",
      protocol: $("intProtocol").value.trim(),
      externalId: $("intExternalId") ? $("intExternalId").value.trim() : "",
      customerName: $("intCustomer").value.trim(),
      customerPhone: $("intPhone").value.trim(),
      payload: {
        text: $("intPayload").value.trim(),
        origin: normalizedCall.originText,
        destination: normalizedCall.destinationText,
        claimNumber: normalizedCall.claimNumber,
        policyNumber: normalizedCall.policyNumber,
        customerPlate: normalizedCall.customerPlate
      },
      payloadText: $("intPayload").value.trim(),
      normalizedCall,
      status: "novo",
      createdAt: new Date().toISOString(),
      createdBy: state.user.uid
    });
    e.target.reset();
    toast("Acionamento externo entrou na fila.", "ok");
  });

  function applyIntegrationToCall(id) {
    const row = state.integrationInbox[id];
    if (!row) return;
    const normalized = row.normalizedCall || {};
    showView("chamados");
    setValue("callClient", normalized.customerName || row.customerName || "");
    setValue("callPhone", normalized.customerPhone || row.customerPhone || "");
    setValue("callSource", "Seguradora");
    setValue("callInsurance", normalized.insurance || row.sourceName || row.source || "");
    setValue("callInsuranceProtocol", normalized.insuranceProtocol || row.protocol || row.externalId || "");
    setValue("callType", normalized.serviceType || "Seguradora");
    setValue("callClaim", normalized.claimNumber || "");
    setValue("callPolicy", normalized.policyNumber || normalized.insuranceProtocol || row.protocol || "");
    setValue("callPolicyNumber", normalized.policyNumber || "");
    setValue("callCustomerPlate", normalized.customerPlate || "");
    setValue("callCustomerVehicle", [normalized.customerVehicle, normalized.vehicleColor, normalized.vehicleYear].filter(Boolean).join(" / "));
    setValue("callPrice", normalized.amount || "");
    if (normalized.amount) setPriceMode("manual", true);
    setValue("callSlaLimit", normalized.slaLimitAt || "");
    setValue("callOriginLabel", normalized.originText || "");
    setValue("callDestLabel", normalized.destinationText || "");
    setValue("callNotes", [normalized.notes, normalized.questionSummary, normalized.tariffSummary, normalized.rawText || row.payloadText || row.payload && row.payload.text || ""].filter(Boolean).join("\n\n"));
    if (normalized.totalRouteKm && $("callTowKm")) {
      setValue("callTowKm", String(normalized.totalRouteKm).replace(".", ","));
      if ($("callTowActive")) $("callTowActive").checked = true;
      calculateTowPricing();
    }
    state.pendingIntegrationId = id;
    db.collection("integrationInbox").doc(id).set({
      status: "em_tratamento",
      lastAppliedToFormAt: new Date().toISOString(),
      handledAt: new Date().toISOString(),
      handledBy: state.user.uid
    }, { merge: true }).catch(() => {});
    toast("Dados aplicados ao formulário de chamado. Complete origem/destino e registre.", "ok");
  }

  async function markIntegrationHandled(id) {
    await db.collection("integrationInbox").doc(id).set({
      status: "tratado",
      handledAt: new Date().toISOString(),
      handledBy: state.user.uid
    }, { merge: true });
    toast("Acionamento marcado como tratado.", "ok");
  }

  function renderVehicles() {
    const rows = visibleRows(state.vehicles).sort((a, b) => String(a.placa || "").localeCompare(String(b.placa || "")));
    const txs = visibleRows(state.transactions);
    const maint = visibleRows(state.maintenance);
    $("fleetTable").innerHTML = rows.length ? `<table><thead><tr><th>Placa</th><th>Tipo</th><th>Status</th><th>Tracker</th><th>Resultado</th></tr></thead><tbody>` + rows.map((v) => {
      const age = minutesSince(v.lastTrackerAt || v.updatedAt);
      const gpsBadge = v.location && age != null && age <= 10 ? "ok" : v.location ? "warn" : "muted";
      const vehicleTx = txs.filter((t) => t.vehicleId === v.id);
      const entrada = vehicleTx.filter((t) => t.type === "entrada").reduce((s, t) => s + Number(t.amount || 0), 0);
      const saida = vehicleTx.filter((t) => t.type === "saida").reduce((s, t) => s + Number(t.amount || 0), 0);
      const operacional = vehicleTx.filter((t) => t.type === "saida" && (t.vehicleCostKind === "operational" || t.sourceType === "driver_expense") && t.vehicleCostKind !== "maintenance").reduce((s, t) => s + Number(t.amount || 0), 0);
      const manutencaoFinanceira = vehicleTx.filter((t) => t.type === "saida" && (t.vehicleCostKind === "maintenance" || t.sourceType === "maintenance" || t.module === "maintenance")).reduce((s, t) => s + Number(t.amount || 0), 0);
      const manutencao = maint.filter((m) => m.vehicleId === v.id).reduce((s, m) => s + Number(m.cost || 0), 0);
      const pendenteMotorista = visibleRows(state.expenses).filter((e) => (e.vehicleId || e.linkedVehicleId) === v.id && e.status === "pendente").reduce((s, e) => s + Number(e.amount || 0), 0);
      const lucro = entrada - saida;
      return `<tr><td><b>${esc(v.placa || v.id)}</b><br><span class="muted small">${esc(v.apelido || "")}</span></td><td>${esc(v.tipo || "")}</td><td><span class="badge info">${esc(v.status || "")}</span></td><td><span class="badge ${gpsBadge}">${age == null ? "sem GPS" : "há " + age + " min"}</span><br><span class="muted small">${esc(v.trackerId || v.trackerDeviceId || "")}</span></td><td>${canSeeSensitiveFinance() ? `<b>${money(lucro)}</b><br><span class="muted small">Receita ${money(entrada)} · Despesas da frota ${money(saida)} · Operacional ${money(operacional)} · Manutenção ${money(Math.max(manutencao, manutencaoFinanceira))}${pendenteMotorista ? ` · Pendente motorista ${money(pendenteMotorista)}` : ""}</span>` : "Restrito"}</td></tr>`;
    }).join("") + `</tbody></table>` : `<p class="muted">Nenhum veículo.</p>`;

    $("vehicleCards").innerHTML = rows.length ? rows.map((v) => {
      const age = minutesSince(v.lastTrackerAt || v.updatedAt);
      return `<div class="card col-3"><b>${esc(v.placa || v.id)}</b><p class="muted small">${esc(v.apelido || v.tipo || "")}</p><span class="badge info">${esc(v.status || "")}</span><p class="small">${v.location ? `Lat ${esc(v.location.lat)}<br>Lng ${esc(v.location.lng)}<br>Última posição há ${age == null ? "?" : age} min` : "Sem posição do tracker"}</p></div>`;
    }).join("") : `<p class="muted">Sem frota cadastrada.</p>`;
  }

  $("vehicleForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!canManageFleet()) return toast("Somente gestor/dono ou gerente pode editar frota.", "danger");
    const placa = plateKey($("vehiclePlate").value);
    if (!placa) return toast("Informe a placa.", "danger");
    if (!isValidPlate(placa)) return toast("Placa inválida. Use ABC1234 ou ABC1D23.", "danger");
    await db.collection("vehicles").doc(placa).set({
      placa,
      apelido: $("vehicleAlias").value.trim(),
      tipo: $("vehicleType").value.trim(),
      trackerId: $("vehicleTrackerId") ? $("vehicleTrackerId").value.trim() : placa,
      trackerDeviceId: $("vehicleTrackerId") ? $("vehicleTrackerId").value.trim() : "",
      trackerProviderId: $("vehicleTrackerProvider") ? $("vehicleTrackerProvider").value : "",
      trackerExternalId: $("vehicleTrackerExternalId") ? $("vehicleTrackerExternalId").value.trim() : "",
      trackerImei: $("vehicleTrackerImei") ? $("vehicleTrackerImei").value.trim() : "",
      trackerPlate: $("vehicleTrackerPlate") ? plateKey($("vehicleTrackerPlate").value) : "",
      trackerEnabled: $("vehicleTrackerEnabled") ? $("vehicleTrackerEnabled").value !== "false" : true,
      status: $("vehicleStatus").value,
      updatedAt: new Date().toISOString(),
      updatedBy: state.user.uid
    }, { merge: true });
    e.target.reset();
    toast("Veículo salvo.", "ok");
  };

  function renderMaintenance() {
    if (!$("maintenanceTable")) return;
    const rows = visibleRows(state.maintenance).sort((a, b) => String(b.date || b.createdAt || "").localeCompare(String(a.date || a.createdAt || "")));
    $("maintenanceTable").innerHTML = rows.length ? `<table><thead><tr><th>Data</th><th>Veículo</th><th>Serviço</th><th>Status</th><th>Custo</th><th>Ações</th></tr></thead><tbody>` + rows.map((m) => {
      const vehicle = state.vehicles[m.vehicleId] || {};
      return `<tr><td>${esc(m.date || dateTime(m.createdAt))}</td><td>${esc(vehicle.placa || m.vehicleId || "-")}</td><td>${esc(m.description || "")}<br><span class="muted small">${esc(m.odometerKm ? m.odometerKm + " km" : "")}</span></td><td><span class="badge info">${esc(m.status || "aberta")}</span></td><td>${canSeeSensitiveFinance() ? money(m.cost || 0) : "Restrito"}</td><td class="row-actions"><button class="btn" onclick="JM.app.editMaintenance('${esc(m.id)}')">Editar</button><button class="btn danger" onclick="JM.app.deleteMaintenance('${esc(m.id)}')">Excluir</button></td></tr>`;
    }).join("") + `</tbody></table>` : `<p class="muted">Nenhuma manutenção registrada.</p>`;
  }

  function renderVehicleCostsLedger() {
    const box = $("vehicleCostsTable") || $("maintenanceTable");
    if (!box || !canSeeSensitiveFinance()) return;
    const rows = visibleRows(state.transactions)
      .filter((t) => t.type === "saida" && t.vehicleId && (t.vehicleCost || t.sourceType === "driver_expense" || t.sourceType === "maintenance" || t.module === "maintenance"))
      .sort((a, b) => String(b.date || b.createdAt || "").localeCompare(String(a.date || a.createdAt || "")));
    const pending = visibleRows(state.expenses)
      .filter((e) => e.status === "pendente" && (e.vehicleId || e.linkedVehicleId))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const html = `<h3 style="margin-top:18px">Despesas do caminhão / custos da frota</h3>` +
      (rows.length || pending.length ? `<table><thead><tr><th>Data</th><th>Veículo</th><th>Origem</th><th>Categoria</th><th>Status</th><th>Valor</th></tr></thead><tbody>` +
      pending.map((e) => {
        const vehicle = state.vehicles[e.vehicleId || e.linkedVehicleId] || {};
        const call = state.calls[e.callId || e.linkedCallId] || {};
        return `<tr><td>${esc(dateTime(e.createdAt))}</td><td>${esc(vehicle.placa || e.vehicleId || e.linkedVehicleId || "-")}</td><td>Motorista pendente<br><span class="muted small">${esc(e.driverName || e.driverId || "")} · ${esc(call.protocolo || e.protocol || "")}</span></td><td>${esc(e.type || e.vehicleCostCategory || "Despesa")}</td><td><span class="badge warn">Aguardando aprovação</span></td><td><b>${money(e.amount || 0)}</b></td></tr>`;
      }).join("") +
      rows.map((t) => {
        const vehicle = state.vehicles[t.vehicleId] || {};
        const kind = vehicleCostKindLabel(t.vehicleCostKind || (t.sourceType === "maintenance" || t.module === "maintenance" ? "maintenance" : "operational"));
        return `<tr><td>${esc(t.date || dateTime(t.createdAt))}</td><td>${esc(vehicle.placa || t.vehicleId || "-")}</td><td>${esc(t.module || t.sourceType || "financeiro")}<br><span class="muted small">${esc(t.protocol || t.callId || "")}</span></td><td>${esc(t.category || t.vehicleCostCategory || "Despesa")}<br><span class="muted small">${esc(kind)}</span></td><td>${esc(t.status || "")}</td><td><b>${money(t.amount || 0)}</b></td></tr>`;
      }).join("") + `</tbody></table>` : `<p class="muted">Nenhuma despesa de frota vinculada a veículo.</p>`);
    if ($("vehicleCostsTable")) box.innerHTML = html;
    else box.insertAdjacentHTML("afterend", html);
  }

  $("maintenanceForm") && ($("maintenanceForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!canManageFleet()) return toast("Somente gestor/dono ou gerente pode lançar manutenção.", "danger");
    const now = new Date().toISOString();
    const payload = {
      vehicleId: $("maintenanceVehicle").value,
      date: $("maintenanceDate").value || todayInput(),
      description: $("maintenanceDesc").value.trim(),
      odometerKm: $("maintenanceKm").value.trim(),
      cost: parseMoney($("maintenanceCost").value),
      status: $("maintenanceStatus").value,
      updatedAt: now,
      updatedBy: state.user.uid
    };
    if (!payload.vehicleId || !payload.description) return toast("Informe veículo e serviço da manutenção.", "danger");
    let maintenanceId = state.editingMaintenanceId;
    if (maintenanceId) {
      await db.collection("maintenance").doc(maintenanceId).set(payload, { merge: true });
      if (canManageFinance()) await upsertTransactionFromMaintenance(maintenanceId, Object.assign({}, state.maintenance[maintenanceId] || {}, payload));
      toast("Manutenção atualizada e refletida no financeiro da frota.", "ok");
    } else {
      const ref = db.collection("maintenance").doc();
      maintenanceId = ref.id;
      await ref.set(Object.assign({ createdAt: now, createdBy: state.user.uid }, payload));
      if (canManageFinance()) await upsertTransactionFromMaintenance(maintenanceId, payload);
      toast("Manutenção registrada e custo lançado no financeiro da frota.", "ok");
    }
    resetMaintenanceForm();
  });

  function editMaintenance(id) {
    if (!canManageFleet()) return toast("Sem permissão para editar manutenção.", "danger");
    const item = state.maintenance[id];
    if (!item) return toast("Manutenção não encontrada.", "danger");
    state.editingMaintenanceId = id;
    setValue("maintenanceVehicle", item.vehicleId || "");
    setValue("maintenanceDate", item.date || "");
    setValue("maintenanceDesc", item.description || "");
    setValue("maintenanceKm", item.odometerKm || "");
    setValue("maintenanceCost", item.cost || "");
    setValue("maintenanceStatus", item.status || "aberta");
    setSubmitText("maintenanceForm", "Salvar alterações da manutenção");
    if ($("maintenanceCancelEdit")) $("maintenanceCancelEdit").classList.remove("hidden");
  }

  async function deleteMaintenance(id) {
    if (!canManageFleet()) return toast("Sem permissão para excluir manutenção.", "danger");
    const item = state.maintenance[id];
    if (!item) return toast("Manutenção não encontrada.", "danger");
    const reason = window.prompt("Motivo para excluir a manutenção:", "Correção de lançamento");
    if (reason === null) return;
    await softDeleteDoc("maintenance", id, item, reason);
    if (item.financialTransactionId && state.transactions[item.financialTransactionId]) {
      await softDeleteDoc("transactions", item.financialTransactionId, state.transactions[item.financialTransactionId], "Manutenção excluída: " + reason);
    }
    toast("Manutenção removida do painel com auditoria e financeiro vinculado baixado.", "ok");
  }

  function renderTeam() {
    const rows = visibleRows(state.users).sort((a, b) => String(a.nome || a.email || "").localeCompare(String(b.nome || b.email || "")));
    $("teamTable").innerHTML = rows.length ? `<table><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Status</th><th>Ações</th></tr></thead><tbody>` +
      rows.map((u) => {
        const canDelete = u.id !== state.user?.uid;
        const deleteButton = canDelete ? `<button class="btn danger" onclick="JM.app.deleteTeamMember('${esc(u.id)}')">Excluir</button>` : "";
        return `<tr><td><b>${esc(u.nome || "")}</b><br><span class="muted small">${esc(u.uid || u.id)}</span></td><td>${esc(u.email || "")}</td><td><span class="badge info">${esc(roleLabel(u.role))}</span></td><td>${u.active === false ? "Inativo" : "Ativo"}</td><td class="row-actions"><button class="btn" onclick="JM.app.editTeamMember('${esc(u.id)}')">Editar</button>${deleteButton}</td></tr>`;
      }).join("") +
      `</tbody></table>` : `<p class="muted">Nenhum usuário.</p>`;
  }

  function roleLabel(role) {
    const labels = {
      admin: "Gestor/Admin",
      gestor: "Gestor",
      gerente: "Gerente",
      auxiliar: "Auxiliar",
      atendente: "Atendente",
      finance: "Financeiro",
      driver: "Motorista",
      motorista: "Motorista"
    };
    return labels[normalizedRole(role)] || role || "Equipe";
  }

  function roleCanAccessJM(role) {
    return OFFICE_ROLES.includes(normalizedRole(role));
  }

  function editTeamMember(id) {
    if (!canManageTeam()) return toast("Somente gestor/dono pode editar funcionários.", "danger");
    const user = state.users[id];
    if (!user) return toast("Funcionário não encontrado.", "danger");
    state.editingUserId = id;
    showView("equipe");
    setValue("teamName", user.nome || "");
    setValue("teamEmail", user.email || "");
    setValue("teamRole", normalizedRole(user.role) === "motorista" ? "driver" : normalizedRole(user.role || "driver"));
    setValue("teamActive", user.active === false ? "false" : "true");
    setValue("teamPass", "");
    if ($("teamEmail")) $("teamEmail").readOnly = true;
    if ($("teamPass")) $("teamPass").placeholder = "deixe em branco para manter";
    setSubmitText("teamForm", "Salvar alterações do funcionário");
    if ($("teamCancelEdit")) $("teamCancelEdit").classList.remove("hidden");
    toast("Edite o funcionário e salve as alterações.", "ok");
  }

  async function deleteTeamMember(id) {
    if (!canManageTeam()) return toast("Somente gestor/dono pode excluir funcionários.", "danger");
    if (id === state.user?.uid) return toast("Você não pode excluir o próprio usuário logado.", "danger");
    const user = state.users[id];
    if (!user) return toast("Funcionário não encontrado.", "danger");
    const email = String(user.email || "").toLowerCase().trim();
    const reason = window.prompt(`Motivo para excluir ${user.nome || email || "este funcionário"} do painel JM:`, "Desligamento da equipe");
    if (reason === null) return;
    await writeAudit("delete", "users", id, user, reason);
    const batch = db.batch();
    batch.set(db.collection("users").doc(id), {
      active: false,
      deletedAt: new Date().toISOString(),
      deletedBy: state.user.uid,
      deletedByEmail: state.user.email,
      auditReason: reason
    }, { merge: true });
    if (email) {
      batch.delete(db.collection("managerAccess").doc(email));
      batch.delete(db.collection("driverAccess").doc(email));
    }
    await batch.commit();
    if (state.editingUserId === id) resetTeamForm();
    toast("Funcionário removido do painel. Remova o Auth manualmente ou por Cloud Function quando disponível.", "ok");
  }

  $("teamForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!canManageTeam()) return toast("Somente gestor/dono pode editar equipe.", "danger");
    const email = $("teamEmail").value.trim().toLowerCase();
    const pass = $("teamPass").value;
    const selectedRole = normalizedRole($("teamRole").value || "driver");
    const isDriverRole = DRIVER_ROLES.includes(selectedRole);
    const isOfficeRole = roleCanAccessJM(selectedRole);
    const editingId = state.editingUserId;

    if (!isDriverRole && !isOfficeRole) return toast("Perfil inválido.", "danger");
    if (isDriverRole && await emailReservedForManager(email)) {
      return toast("Este e-mail está liberado como gestor/equipe interna. Ele não pode ser salvo como motorista.", "danger");
    }
    if (!editingId && !pass) return toast("Informe uma senha inicial para criar o usuário no Firebase Auth.", "danger");
    if (editingId && pass) return toast("Senha de usuário existente deve ser redefinida no Firebase Authentication.", "danger");

    let uid = editingId || uidSafe(email);
    if (pass) {
      if (pass.length < 6) return toast("Informe uma senha inicial com pelo menos 6 caracteres.", "danger");
      try {
        const cred = await secondaryAuth.createUserWithEmailAndPassword(email, pass);
        uid = cred.user.uid;
        await secondaryAuth.signOut().catch(() => {});
      } catch (err) {
        if (err && err.code === "auth/email-already-in-use") {
          // Para gestor/gerente/atendente, o jm.html repara users/{uid} no primeiro login usando managerAccess/{email}.
          // Para motorista, o painel motorista tambem procura por e-mail e repara o UID quando possivel.
          uid = uidSafe(email);
        } else {
          return toast(friendlyAuthError(err), "danger");
        }
      }
    }

    const payload = {
      uid,
      nome: $("teamName").value.trim(),
      email,
      role: selectedRole,
      active: $("teamActive").value === "true",
      updatedAt: new Date().toISOString(),
      updatedBy: state.user.uid,
      source: "jm-teamForm"
    };

    await db.collection("users").doc(uid).set(payload, { merge: true });
    const accessPayload = Object.assign({ createdAt: new Date().toISOString() }, payload);
    if (isOfficeRole) {
      await db.collection("managerAccess").doc(email).set(accessPayload, { merge: true });
      await db.collection("driverAccess").doc(email).delete().catch(() => {});
    }
    if (isDriverRole) {
      try {
        await db.collection("driverAccess").doc(email).set(accessPayload, { merge: true });
        await db.collection("managerAccess").doc(email).delete().catch(() => {});
      } catch (err) {
        toast("Motorista salvo, mas driverAccess foi bloqueado. Publique as novas firestore.rules para liberar o primeiro login.", "danger");
        return;
      }
    }
    resetTeamForm();
    toast(roleLabel(selectedRole) + " salvo na equipe.", "ok");
  };

  function renderDriverPanel() {
    const myCalls = Object.values(state.calls).filter((c) => isAdmin() || c.driverId === state.user?.uid);
    $("driverCalls").innerHTML = myCalls.length ? myCalls.map((c) => {
      const vehicle = state.vehicles[c.vehicleId] || {};
      const url = c.routeExternalUrl || c.routeUrl || mapsRouteUrl(c, vehicle);
      const metric = c.routeDistanceText || (routeKm(c, vehicle) ? routeKm(c, vehicle).toFixed(1).replace(".", ",") + " km" : "Sem rota");
      return `<div class="card" style="margin-bottom:12px"><div class="actions"><div><b>${esc(c.protocolo || c.cliente)}</b><br><span class="muted small">${esc(c.originLabel || "")} → ${esc(c.destLabel || "")}</span></div><span class="badge ${statusClass(c.status)}">${esc(c.status || "")}</span></div><p>${esc(c.notes || "")}</p><p><b>${esc(metric)}</b></p>${url ? `<a class="btn primary" target="_blank" rel="noopener noreferrer" href="${esc(url)}">Abrir rota</a>` : ""}</div>`;
    }).join("") : `<p class="muted">Nenhum chamado.</p>`;
  }

  $("expenseForm") && ($("expenseForm").onsubmit = async (e) => {
    e.preventDefault();
    const data = {
      callId: $("expenseCall").value,
      vehicleId: $("expenseVehicle").value,
      type: $("expenseType").value,
      amount: parseMoney($("expenseAmount").value),
      notes: $("expenseNotes").value.trim(),
      status: "pendente",
      driverId: state.user.uid,
      driverName: state.profile.nome || state.user.email,
      createdAt: new Date().toISOString()
    };
    if (data.callId) {
      const call = state.calls[data.callId] || {};
      data.vehicleId = data.vehicleId || call.vehicleId || "";
      data.customerId = call.customerId || "";
      data.billingParty = callDisplayName(call);
      data.protocol = callProtocolLabel(call, data.callId);
      data.insurance = call.insurance || "";
      data.insuranceProtocol = call.insuranceProtocol || "";
    }
    if (isVehicleCostType(data.type, data.notes) && !data.vehicleId) {
      return toast("Despesa de frota precisa estar vinculada a um veículo. Selecione o caminhão/guincho antes de enviar.", "danger");
    }
    data.vehicleCost = !!data.vehicleId;
    data.vehicleCostKind = vehicleCostKind(data.type, data.notes);
    data.vehicleCostCategory = data.type || "Despesa motorista";
    await db.collection("expenses").add(data);
    e.target.reset();
    toast("Despesa enviada para aprovação já vinculada ao chamado/veículo.", "ok");
  });

  function aiSetStatus(text, tone) {
    const el = $("aiStatus");
    if (!el) return;
    el.textContent = text || "";
    el.className = "small " + (tone || "muted");
  }

  function previewAiFile() {
    const file = $("aiSourceFile") && $("aiSourceFile").files && $("aiSourceFile").files[0];
    const box = $("aiFilePreview");
    if (!box) return;
    if (!file) {
      box.innerHTML = "Nenhum arquivo selecionado.";
      return;
    }
    if (/^image\//i.test(file.type)) {
      const url = URL.createObjectURL(file);
      box.innerHTML = `<img src="${esc(url)}" alt="Print enviado"><span>${esc(file.name)} · ${Math.round(file.size / 1024)} KB</span>`;
      return;
    }
    box.textContent = file.name + " · " + Math.round(file.size / 1024) + " KB";
  }

  async function extractAiFileText() {
    const file = $("aiSourceFile") && $("aiSourceFile").files && $("aiSourceFile").files[0];
    if (!file) return aiSetStatus("Selecione um print antes de ler.", "warn");
    if (!/^image\//i.test(file.type)) return aiSetStatus("Leitura automática aceita imagens. Para PDF, cole o texto no campo.", "warn");
    const btn = $("btnAiExtract");
    setButtonBusy(btn, true, "Lendo...");
    aiSetStatus("Lendo print no navegador. Pode levar alguns segundos.", "muted");
    try {
      const tesseract = await import("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js");
      const worker = await tesseract.createWorker("por+eng");
      const result = await worker.recognize(file);
      await worker.terminate();
      const text = result && result.data && result.data.text || "";
      const current = $("aiSourceText").value.trim();
      $("aiSourceText").value = [current, text.trim()].filter(Boolean).join("\n\n");
      aiSetStatus(text.trim() ? "Texto extraído. Revise e gere os rascunhos." : "Não consegui identificar texto útil no print.", text.trim() ? "ok" : "warn");
    } catch (err) {
      console.warn("Falha OCR", err);
      aiSetStatus("Não foi possível ler o print automaticamente. Cole o texto e gere os rascunhos.", "warn");
    } finally {
      setButtonBusy(btn, false);
    }
  }

  function aiLines(text) {
    return String(text || "")
      .replace(/\t+/g, " ")
      .replace(/\u00a0/g, " ")
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  function aiKey(text) {
    return String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[º°]/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  const AI_LABELS = [
    "item de cobertura", "situação", "situacao", "valor total", "percurso total", "distância da base", "distancia da base",
    "técnico", "tecnico", "ordem de serviço", "ordem de servico", "cliente", "solicitante", "beneficiário", "beneficiario",
    "telefone", "telefone do beneficiário", "telefone do beneficiario", "veículo", "veiculo", "placa", "ano", "cor do veículo",
    "cor do veiculo", "causa", "observação", "observacao", "observações", "observacoes", "questionário", "questionario",
    "endereço", "endereco", "endereço de acionamento", "endereco de acionamento", "origem", "destino", "tarifas",
    "perguntas", "valores", "serviço", "servico", "protocolo", "previsão", "previsao", "data agendamento",
    "nome / nome fantasia", "nome fantasia", "tipo de serviço", "tipo de servico", "valor", "viatura próxima",
    "viatura proxima", "combustível", "combustivel"
  ];

  function aiIsLabel(line, labels) {
    const key = aiKey(line).replace(/\b\d+(?:[,.]\d+)?\s*km\b/g, "").trim();
    return (labels || []).some((label) => {
      const labelKey = aiKey(label);
      return key === labelKey || key.startsWith(labelKey + " ");
    });
  }

  function aiMeaningfulInlineValue(value) {
    const clean = String(value || "").replace(/^[:\-–—]\s*/, "").trim();
    if (!clean) return "";
    if (/^\(?\s*\d+(?:[.,]\d+)?\s*km\s*\)?$/i.test(clean)) return "";
    return clean;
  }

  function aiInlineValue(line, labels) {
    const raw = String(line || "").trim();
    const colon = raw.match(/[:：]\s*(.+)$/);
    for (const label of labels || []) {
      const labelKey = aiKey(label);
      const key = aiKey(raw);
      if (!key.startsWith(labelKey)) continue;
      if (colon) return aiMeaningfulInlineValue(colon[1]);
      if (key === labelKey) return "";
      const words = String(label || "").split(/\s+/).filter(Boolean);
      const rest = raw.split(/\s+/).slice(words.length).join(" ");
      const value = aiMeaningfulInlineValue(rest);
      if (value && aiKey(value) !== labelKey) return value;
    }
    return "";
  }

  function aiValue(text, labels, stopLabels) {
    const lines = Array.isArray(text) ? text : aiLines(text);
    const stops = stopLabels || AI_LABELS;
    for (let i = 0; i < lines.length; i++) {
      if (!aiIsLabel(lines[i], labels)) continue;
      const inline = aiInlineValue(lines[i], labels);
      if (inline) return inline;
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        const candidate = lines[j];
        if (aiIsLabel(candidate, stops)) break;
        if (/^(Finalizado|Em andamento|Pendente|\+|−|-|Leaflet|©)/i.test(candidate)) continue;
        return candidate;
      }
    }
    return "";
  }

  function aiBlock(text, startLabels, stopLabels) {
    const lines = Array.isArray(text) ? text : aiLines(text);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (!aiIsLabel(lines[i], startLabels)) continue;
      const inline = aiInlineValue(lines[i], startLabels);
      if (inline) out.push(inline);
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j];
        if (aiIsLabel(candidate, stopLabels || AI_LABELS)) break;
        if (/^(\+|−|Leaflet|©|Tarifa\s+|Valor Total\s*$)/i.test(candidate)) continue;
        out.push(candidate);
      }
      break;
    }
    return out.join("\n").trim();
  }

  function aiMatch(text, regex) {
    const m = String(text || "").match(regex);
    return m ? String(m[1] || m[0] || "").trim() : "";
  }

  function aiMoneyMatches(text) {
    return Array.from(String(text || "").matchAll(/(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2}|\d{1,6}[.,]\d{2})/g)).map((m) => m[0]);
  }

  function aiAmount(text) {
    const raw = String(text || "");
    const explicit = aiMatch(raw, /(?:valor\s+total|valor|total)\s*[:\-]?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2}|\d{1,6}[.,]\d{2})/i);
    if (explicit) return parseMoney(explicit);
    const monies = aiMoneyMatches(raw);
    return monies.length ? parseMoney(monies[0]) : 0;
  }

  function aiMoneyNear(lines, labels) {
    for (let i = 0; i < lines.length; i++) {
      if (!aiIsLabel(lines[i], labels)) continue;
      const candidates = [aiInlineValue(lines[i], labels), lines[i - 1], lines[i + 1]].filter(Boolean);
      for (const candidate of candidates) {
        if (!/R\$/i.test(candidate)) continue;
        const money = aiMoneyMatches(candidate)[0];
        if (money) return parseMoney(money);
      }
      for (const candidate of candidates) {
        const money = aiMoneyMatches(candidate)[0];
        if (money) return parseMoney(money);
      }
    }
    return 0;
  }

  function aiKmNear(lines, labels) {
    for (let i = 0; i < lines.length; i++) {
      if (!aiIsLabel(lines[i], labels)) continue;
      const candidates = [aiInlineValue(lines[i], labels), lines[i - 1], lines[i + 1]].filter(Boolean);
      for (const candidate of candidates) {
        const m = String(candidate).match(/(\d+(?:[.,]\d+)?)\s*km/i);
        if (m) return parseFloat(String(m[1]).replace(",", "."));
      }
    }
    return 0;
  }

  function aiKmValueFromLine(line) {
    const m = String(line || "").match(/(\d+(?:[.,]\d+)?)\s*km/i);
    return m ? parseFloat(String(m[1]).replace(",", ".")) : 0;
  }

  function aiMetricKm(lines, labels, nextValueStolenByLabels) {
    const stealers = nextValueStolenByLabels || [];
    for (let i = 0; i < lines.length; i++) {
      if (!aiIsLabel(lines[i], labels)) continue;
      const inline = aiKmValueFromLine(aiInlineValue(lines[i], labels));
      if (inline) return inline;
      const next = aiKmValueFromLine(lines[i + 1]);
      const previous = aiKmValueFromLine(lines[i - 1]);
      if (next && !(lines[i + 2] && aiIsLabel(lines[i + 2], stealers))) return next;
      if (previous) return previous;
      if (next) return next;
    }
    return 0;
  }

  function aiDetectInsurance(raw, lines) {
    if (/maxpar/i.test(raw)) return "Maxpar";
    if (/amparo\s+assist/i.test(raw)) return "Amparo Assistência";
    if (/veniti/i.test(raw)) return "Veniti";
    return aiValue(lines, ["seguradora", "assistência", "assistencia", "cliente"]) || "";
  }

  function aiQuestions(lines) {
    const start = lines.findIndex((line) => aiIsLabel(line, ["questionário", "questionario", "perguntas"]));
    if (start < 0) return [];
    const questions = [];
    let current = null;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (aiIsLabel(line, ["endereço", "endereco", "tarifas", "valores"])) break;
      if (!line || /^(\+|−|-|Leaflet|©)$/i.test(line)) continue;
      if (/\?$/.test(line)) {
        if (current) questions.push(current);
        current = { question: line, answer: "" };
      } else if (current) {
        current.answer = [current.answer, line].filter(Boolean).join(" ");
      }
    }
    if (current) questions.push(current);
    return questions;
  }

  function aiTariffs(lines) {
    const start = lines.findIndex((line) => aiIsLabel(line, ["tarifas", "valores"]));
    if (start < 0) return [];
    const rows = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^(total|valor total|beneficiário pagará|beneficiario pagara)/i.test(line)) continue;
      if (!/(saida|saída|km|hora|cobertura|guincho|reboque|munck)/i.test(line)) continue;
      const monies = aiMoneyMatches(line);
      const plainNumbers = Array.from(line.matchAll(/\b\d{1,3}(?:\.\d{3})*,\d{2}\b|\b\d+(?:[.,]\d{1,2})\b/g)).map((m) => m[0]);
      const totalText = monies[monies.length - 1] || plainNumbers[plainNumbers.length - 1] || "";
      const unitText = monies[0] || (plainNumbers.length > 1 ? plainNumbers[plainNumbers.length - 2] : "");
      let quantityText = plainNumbers.length > 2 ? plainNumbers[plainNumbers.length - 3] : "";
      if (/R\$/i.test(line) && monies.length >= 2) {
        const betweenMoney = line.slice(line.indexOf(monies[0]) + monies[0].length, line.lastIndexOf(monies[monies.length - 1]));
        const qtyMatch = betweenMoney.match(/\b(\d+(?:[.,]\d+)?)\b/);
        if (qtyMatch) quantityText = qtyMatch[1];
      }
      const description = line
        .replace(/R\$\s*/gi, "")
        .replace(/\d{1,3}(?:\.\d{3})*,\d{2}|\d+(?:[.,]\d{1,2})/g, "")
        .replace(/\s+/g, " ")
        .trim();
      rows.push({
        description: description || "Tarifa",
        quantity: quantityText ? parseFloat(quantityText.replace(".", "").replace(",", ".")) : 1,
        unitAmount: unitText ? parseMoney(unitText) : 0,
        amount: totalText ? parseMoney(totalText) : 0,
        raw: line
      });
    }
    return rows;
  }

  function aiBuildInsuranceCall(raw) {
    const lines = aiLines(raw);
    const insurance = aiDetectInsurance(raw, lines);
    const protocol = aiValue(lines, ["protocolo", "ordem de serviço", "ordem de servico", "os"]) ||
      aiMatch(raw, /\b([A-Z]{2,}\d{4,}(?:\/\d+){0,3}|A\d{8,}\/\d+)\b/i);
    const beneficiary = aiValue(lines, ["beneficiário", "beneficiario", "nome / nome fantasia", "nome fantasia"]);
    const requester = aiValue(lines, ["solicitante"]);
    const billingClient = aiValue(lines, ["cliente"]) || insurance;
    const client = beneficiary || billingClient || requester;
    const phone = aiValue(lines, ["telefone do beneficiário", "telefone do beneficiario", "telefone"]) ||
      aiMatch(raw, /(?:\+?55\s*)?\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4}/);
    const vehicle = aiValue(lines, ["veículo", "veiculo"]);
    const plate = plateKey(aiValue(lines, ["placa"]) || aiMatch(raw, /\b([A-Z]{3}[-\s]?[0-9][A-Z0-9][0-9]{2}|[A-Z]{3}[-\s]?[0-9]{4})\b/i));
    const year = aiValue(lines, ["ano"]);
    const color = aiValue(lines, ["cor do veículo", "cor do veiculo"]);
    const cause = aiValue(lines, ["causa"]);
    const serviceType = aiValue(lines, ["tipo de serviço", "tipo de servico", "serviço", "servico"]) || "Guincho";
    const externalStatus = aiValue(lines, ["situação", "situacao"]) || (/finalizado/i.test(raw) ? "Finalizado" : "");
    const origin = aiBlock(lines, ["origem"], ["destino", "tarifas", "valores", "perguntas", "questionário", "questionario"]) ||
      aiBlock(lines, ["endereço de acionamento", "endereco de acionamento"], ["origem", "destino", "tarifas", "valores", "perguntas"]);
    const destination = aiBlock(lines, ["destino"], ["tarifas", "valores", "perguntas", "questionário", "questionario"]);
    const observations = aiBlock(lines, ["observação", "observacao", "observações", "observacoes"], ["tipo de serviço", "tipo de servico", "endereço", "endereco", "perguntas", "valores", "tarifas"]);
    const questions = aiQuestions(lines);
    const tariffs = aiTariffs(lines);
    const totalRouteKm = aiMetricKm(lines, ["percurso total"], ["distância da base", "distancia da base", "viatura próxima", "viatura proxima"]);
    const baseDistanceKm = aiMetricKm(lines, ["distância da base", "distancia da base", "viatura próxima", "viatura proxima"]);
    const amount = aiMoneyNear(lines, ["valor total", "valor"]) || aiAmount(raw) || tariffs.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const mapLinks = Array.from(raw.matchAll(/https?:\/\/\S+/gi)).map((m) => m[0].replace(/[),.;]+$/, ""));
    const notes = [
      requester ? "Solicitante: " + requester : "",
      billingClient && billingClient !== insurance ? "Cliente/associado/pagador: " + billingClient : "",
      externalStatus ? "Status no portal: " + externalStatus : "",
      cause ? "Causa: " + cause : "",
      observations ? "Observações do acionamento: " + observations : "",
      questions.length ? "Perguntas da seguradora:\n" + questions.map((q) => "- " + q.question + " " + q.answer).join("\n") : "",
      tariffs.length ? "Tarifas:\n" + tariffs.map((row) => "- " + row.raw).join("\n") : ""
    ].filter(Boolean).join("\n\n");
    return {
      client,
      beneficiary,
      requester,
      billingClient,
      phone,
      insurance,
      protocol,
      sourceName: insurance || billingClient || "Assistente IA",
      serviceType,
      origin,
      destination,
      plate,
      vehicle,
      year,
      color,
      cause,
      amount,
      totalRouteKm,
      baseDistanceKm,
      questions,
      tariffs,
      mapLinks,
      notes,
      externalStatus,
      rawText: raw
    };
  }

  function buildAiDrafts(text) {
    const raw = String(text || "").trim();
    if (!raw) return [];
    const lower = statusLower(raw);
    const drafts = [];
    const callData = aiBuildInsuranceCall(raw);
    const insuranceLike = /maxpar|amparo|veniti|assist[eê]ncia|seguradora|protocolo|ordem de servi[cç]o|benefici[aá]rio|acionamento|origem|destino|tarifas|perguntas/i.test(raw);
    if (insuranceLike || callData.protocol || callData.origin || callData.destination) {
      drafts.push({
        kind: "call",
        title: "Chamado oficial de seguradora",
        rawText: raw,
        data: callData
      });
    }
    const amount = callData.amount || aiAmount(raw);
    const plate = callData.plate || plateKey(aiValue(raw, ["placa", "veículo", "veiculo"]) || aiMatch(raw, /\b([A-Z]{3}[0-9][A-Z0-9][0-9]{2}|[A-Z]{3}[0-9]{4})\b/i));
    const client = callData.client || aiValue(raw, ["cliente", "nome", "segurado", "condutor"]);
    const insurance = callData.insurance || aiValue(raw, ["seguradora", "assistência", "assistencia"]);
    if (/despesa|combust[ií]vel|ped[aá]gio|manuten[cç][aã]o|nota|recibo|oficina|estacionamento|lavagem/.test(lower)) {
      drafts.push({
        kind: "expense",
        title: "Rascunho de despesa",
        rawText: raw,
        data: {
          description: aiValue(raw, ["descrição", "descricao", "item"]) || "Despesa lançada por IA",
          category: aiValue(raw, ["categoria", "tipo"]) || "Despesa operacional",
          amount,
          plate,
          status: "Pendente"
        }
      });
    }
    if (/pagamento|fatura|boleto|pix|receber|cobran[cç]a|lan[cç]amento|nf|nota fiscal/.test(lower) && !/despesa|recibo de despesa/.test(lower)) {
      drafts.push({
        kind: "finance",
        title: "Rascunho financeiro",
        rawText: raw,
        data: {
          type: /pagar|despesa|sa[ií]da/.test(lower) ? "saida" : "entrada",
          description: aiValue(raw, ["descrição", "descricao", "histórico", "historico"]) || "Lançamento criado por IA",
          category: aiValue(raw, ["categoria", "tipo"]) || "Operacional",
          billingParty: insurance || client || aiValue(raw, ["pagador", "recebedor"]),
          status: /recebido|pago|quitado/.test(lower) ? "Recebido" : "A receber",
          amount
        }
      });
    }
    if (!drafts.length) {
      drafts.push({
        kind: "note",
        title: "Texto interpretado",
        rawText: raw,
        data: { description: raw.slice(0, 180), amount }
      });
    }
    return drafts;
  }

  function analyzeAiInput() {
    const text = $("aiSourceText") && $("aiSourceText").value || "";
    state.aiDrafts = buildAiDrafts(text);
    renderAiReview();
    aiSetStatus(state.aiDrafts.length ? "Rascunhos prontos para revisão." : "Cole um texto ou leia um print para gerar rascunhos.", state.aiDrafts.length ? "ok" : "warn");
  }

  function aiInput(id, label, value, wide) {
    return `<div class="${wide ? "wide" : ""}"><label>${esc(label)}</label><input id="${esc(id)}" value="${esc(value || "")}"></div>`;
  }

  function aiTextarea(id, label, value, wide) {
    return `<div class="${wide ? "wide" : ""}"><label>${esc(label)}</label><textarea id="${esc(id)}">${esc(value || "")}</textarea></div>`;
  }

  function aiReviewValue(index, key) {
    const el = $(`ai_${index}_${key}`);
    return el ? el.value.trim() : "";
  }

  function renderAiReview() {
    const box = $("aiReviewBox");
    if (!box) return;
    const drafts = state.aiDrafts || [];
    if (!drafts.length) {
      box.innerHTML = `<p class="muted">Nenhum rascunho gerado ainda.</p>`;
      return;
    }
    box.innerHTML = drafts.map((draft, index) => {
      const d = draft.data || {};
      let fields = "";
      if (draft.kind === "call") {
        const tariffSummary = (d.tariffs || []).map((row) => row.raw || row.description).filter(Boolean).join("\n");
        const questionSummary = (d.questions || []).map((q) => `${q.question} ${q.answer || ""}`.trim()).join("\n");
        fields = [
          aiInput(`ai_${index}_client`, "Beneficiário / cliente final", d.client),
          aiInput(`ai_${index}_phone`, "WhatsApp", d.phone),
          aiInput(`ai_${index}_insurance`, "Assistência / seguradora", d.insurance),
          aiInput(`ai_${index}_billingClient`, "Cliente / associado / pagador", d.billingClient),
          aiInput(`ai_${index}_requester`, "Solicitante", d.requester),
          aiInput(`ai_${index}_protocol`, "Protocolo / ordem de serviço", d.protocol),
          aiInput(`ai_${index}_serviceType`, "Tipo de serviço", d.serviceType),
          aiInput(`ai_${index}_plate`, "Placa", d.plate),
          aiInput(`ai_${index}_vehicle`, "Veículo", d.vehicle, true),
          aiInput(`ai_${index}_color`, "Cor", d.color),
          aiInput(`ai_${index}_year`, "Ano", d.year),
          aiInput(`ai_${index}_amount`, "Valor", d.amount ? String(d.amount).replace(".", ",") : ""),
          aiInput(`ai_${index}_totalRouteKm`, "Percurso total KM", d.totalRouteKm ? String(d.totalRouteKm).replace(".", ",") : ""),
          aiInput(`ai_${index}_baseDistanceKm`, "Distância base / viatura KM", d.baseDistanceKm ? String(d.baseDistanceKm).replace(".", ",") : ""),
          aiInput(`ai_${index}_origin`, "Origem", d.origin, true),
          aiInput(`ai_${index}_destination`, "Destino", d.destination, true),
          aiTextarea(`ai_${index}_notes`, "Observações oficiais do acionamento", d.notes, true),
          aiTextarea(`ai_${index}_questions`, "Perguntas da seguradora", questionSummary, true),
          aiTextarea(`ai_${index}_tariffs`, "Tarifas / composição de valor", tariffSummary, true)
        ].join("");
      } else if (draft.kind === "finance" || draft.kind === "expense") {
        fields = [
          `<div><label>Tipo</label><select id="ai_${index}_type"><option value="entrada"${d.type === "entrada" ? " selected" : ""}>Entrada</option><option value="saida"${d.type === "saida" || draft.kind === "expense" ? " selected" : ""}>Saída</option></select></div>`,
          aiInput(`ai_${index}_amount`, "Valor", d.amount ? String(d.amount).replace(".", ",") : ""),
          aiInput(`ai_${index}_description`, "Descrição", d.description, true),
          aiInput(`ai_${index}_category`, "Categoria", d.category),
          aiInput(`ai_${index}_party`, "Cliente/seguradora", d.billingParty),
          `<div><label>Status</label><select id="ai_${index}_status"><option${d.status === "A receber" ? " selected" : ""}>A receber</option><option${d.status === "Recebido" ? " selected" : ""}>Recebido</option><option${d.status === "Pendente" ? " selected" : ""}>Pendente</option><option${d.status === "Pago" ? " selected" : ""}>Pago</option></select></div>`
        ].join("");
      } else {
        fields = `<div class="wide"><label>Observação</label><textarea id="ai_${index}_description">${esc(d.description || draft.rawText || "")}</textarea></div>`;
      }
      return `<div class="ai-draft-card">
        <div class="ai-draft-head">
          <div><h3>${esc(draft.title)}</h3><p class="muted small">Revise os campos antes de aplicar ou salvar.</p></div>
          <span class="badge info">${esc(draft.kind)}</span>
        </div>
        <div class="form-grid">${fields}</div>
        <div class="actions" style="margin-top:10px">
          ${draft.kind !== "note" ? `<button class="btn" onclick="JM.app.applyAiDraft(${index})">Aplicar no formulário</button>` : ""}
          <button class="btn good" onclick="JM.app.saveAiDraft(${index})">Salvar revisado</button>
        </div>
      </div>`;
    }).join("");
  }

  function applyAiDraft(index) {
    const draft = state.aiDrafts[index];
    if (!draft) return;
    if (draft.kind === "call") {
      showView("chamados");
      setValue("callClient", aiReviewValue(index, "client"));
      setValue("callPhone", aiReviewValue(index, "phone"));
      setValue("callSource", "Seguradora");
      setValue("callType", aiReviewValue(index, "serviceType") || "Seguradora");
      setValue("callInsurance", aiReviewValue(index, "insurance"));
      setValue("callInsuranceProtocol", aiReviewValue(index, "protocol"));
      setValue("callPolicy", aiReviewValue(index, "protocol"));
      setValue("callCustomerPlate", aiReviewValue(index, "plate"));
      setValue("callCustomerVehicle", [aiReviewValue(index, "vehicle"), aiReviewValue(index, "color"), aiReviewValue(index, "year")].filter(Boolean).join(" / "));
      setValue("callPrice", aiReviewValue(index, "amount"));
      if (aiReviewValue(index, "amount")) setPriceMode("manual", true);
      setValue("callOriginLabel", aiReviewValue(index, "origin"));
      setValue("callDestLabel", aiReviewValue(index, "destination"));
      setValue("callNotes", [aiReviewValue(index, "notes"), aiReviewValue(index, "questions"), aiReviewValue(index, "tariffs")].filter(Boolean).join("\n\n"));
      const totalRouteKm = parseMoney(aiReviewValue(index, "totalRouteKm"));
      if (totalRouteKm && $("callTowKm")) {
        setValue("callTowKm", String(totalRouteKm).replace(".", ","));
        if ($("callTowActive")) $("callTowActive").checked = true;
        calculateTowPricing();
      }
      toast("Chamado de seguradora aplicado no formulário. Confira rota, frota e valor antes de registrar.", "ok");
      return;
    }
    showView("financeiro");
    setValue("finType", $(`ai_${index}_type`).value);
    setValue("finDesc", $(`ai_${index}_description`).value);
    setValue("finAmount", $(`ai_${index}_amount`).value);
    setValue("finCategory", $(`ai_${index}_category`).value);
    setValue("finStatus", $(`ai_${index}_status`).value);
    toast("Rascunho aplicado no financeiro. Revise e salve.", "ok");
  }

  async function saveAiDraft(index) {
    const draft = state.aiDrafts[index];
    if (!draft) return toast("Rascunho não encontrado.", "danger");
    const now = new Date().toISOString();
    if (draft.kind === "call") {
      if (!canOperateCalls()) return toast("Sem permissão para salvar chamado.", "danger");
      const original = draft.data || {};
      const reviewed = {
        insurance: aiReviewValue(index, "insurance"),
        billingClient: aiReviewValue(index, "billingClient"),
        requester: aiReviewValue(index, "requester"),
        protocol: aiReviewValue(index, "protocol"),
        serviceType: aiReviewValue(index, "serviceType"),
        customerName: aiReviewValue(index, "client"),
        customerPhone: aiReviewValue(index, "phone"),
        customerPlate: plateKey(aiReviewValue(index, "plate")),
        customerVehicle: aiReviewValue(index, "vehicle"),
        vehicleColor: aiReviewValue(index, "color"),
        vehicleYear: aiReviewValue(index, "year"),
        originText: aiReviewValue(index, "origin"),
        destinationText: aiReviewValue(index, "destination"),
        amount: parseMoney(aiReviewValue(index, "amount")),
        totalRouteKm: parseMoney(aiReviewValue(index, "totalRouteKm")),
        baseDistanceKm: parseMoney(aiReviewValue(index, "baseDistanceKm")),
        notes: aiReviewValue(index, "notes"),
        questionSummary: aiReviewValue(index, "questions"),
        tariffSummary: aiReviewValue(index, "tariffs")
      };
      const payload = {
        source: reviewed.insurance || "Assistente IA",
        sourceName: reviewed.insurance || "Assistente IA",
        sourceType: "ai_insurance_parser",
        protocol: reviewed.protocol,
        externalId: reviewed.protocol,
        customerName: reviewed.customerName,
        customerPhone: reviewed.customerPhone,
        customerPlate: reviewed.customerPlate,
        originText: reviewed.originText,
        destinationText: reviewed.destinationText,
        status: "novo",
        normalizedCall: {
          source: "Seguradora",
          insurance: reviewed.insurance,
          billingClient: reviewed.billingClient,
          requester: reviewed.requester,
          insuranceProtocol: reviewed.protocol,
          serviceType: reviewed.serviceType,
          customerName: reviewed.customerName,
          customerPhone: reviewed.customerPhone,
          customerPlate: reviewed.customerPlate,
          customerVehicle: reviewed.customerVehicle,
          vehicleColor: reviewed.vehicleColor,
          vehicleYear: reviewed.vehicleYear,
          originText: reviewed.originText,
          destinationText: reviewed.destinationText,
          amount: reviewed.amount,
          totalRouteKm: reviewed.totalRouteKm,
          baseDistanceKm: reviewed.baseDistanceKm,
          notes: reviewed.notes,
          questions: original.questions || [],
          tariffs: original.tariffs || [],
          questionSummary: reviewed.questionSummary,
          tariffSummary: reviewed.tariffSummary,
          mapLinks: original.mapLinks || [],
          rawText: draft.rawText || "",
          parserVersion: "jm-v28-ia-seguradoras-checklist"
        },
        rawPayload: draft.rawText || "",
        payload: Object.assign({}, original, reviewed),
        createdAt: now,
        createdBy: state.user.uid,
        updatedAt: now,
        updatedBy: state.user.uid
      };
      await db.collection("integrationInbox").add(payload);
      toast("Rascunho salvo na fila de integrações para validar e gerar chamado.", "ok");
      showView("integracoes");
      return;
    }
    if (draft.kind === "note") {
      if (!canOperateCalls()) return toast("Sem permissão para salvar anotação.", "danger");
      await db.collection("integrationInbox").add({
        source: "Assistente IA",
        sourceName: "Assistente IA",
        sourceType: "ai_note",
        status: "novo",
        rawPayload: draft.rawText || ($(`ai_${index}_description`) && $(`ai_${index}_description`).value || ""),
        normalizedCall: { rawText: draft.rawText || "" },
        createdAt: now,
        createdBy: state.user.uid,
        updatedAt: now,
        updatedBy: state.user.uid
      });
      toast("Texto salvo na fila para triagem.", "ok");
      showView("integracoes");
      return;
    }
    if (!canManageFinance()) return toast("Sem permissão para salvar financeiro.", "danger");
    const type = draft.kind === "expense" ? "saida" : ($(`ai_${index}_type`) && $(`ai_${index}_type`).value || "entrada");
    await db.collection("transactions").add({
      module: "ai_assistant",
      sourceType: draft.kind === "expense" ? "ai_expense" : "ai_finance",
      type,
      date: todayInput(),
      description: $(`ai_${index}_description`).value.trim(),
      amount: parseMoney($(`ai_${index}_amount`).value),
      status: $(`ai_${index}_status`) ? $(`ai_${index}_status`).value : (type === "saida" ? "Pendente" : "A receber"),
      category: $(`ai_${index}_category`) ? $(`ai_${index}_category`).value.trim() : "Assistente IA",
      billingParty: $(`ai_${index}_party`) ? $(`ai_${index}_party`).value.trim() : "",
      aiReviewed: true,
      rawPayload: draft.rawText || "",
      createdAt: now,
      createdBy: state.user.uid,
      updatedAt: now,
      updatedBy: state.user.uid
    });
    toast(draft.kind === "expense" ? "Despesa salva no financeiro." : "Lançamento financeiro salvo.", "ok");
  }

  function renderFinance() {
    if (!$("financeTable")) return;
    if (!canManageFinance()) {
      $("financeTable").innerHTML = `<p class="muted">Financeiro disponível somente para gestor/dono e perfil financeiro.</p>`;
      if ($("expenseApproval")) $("expenseApproval").innerHTML = "";
      return;
    }
    const filter = {
      text: statusLower($("financeSearch") && $("financeSearch").value || ""),
      type: $("financeTypeFilter") && $("financeTypeFilter").value || "",
      status: statusLower($("financeStatusFilter") && $("financeStatusFilter").value || ""),
      start: $("financeStartDate") && $("financeStartDate").value || "",
      end: $("financeEndDate") && $("financeEndDate").value || ""
    };
    const allRows = visibleRows(state.transactions).sort((a, b) => String(b.createdAt || b.date || "").localeCompare(String(a.createdAt || a.date || "")));
    const rows = allRows.filter((t) => {
      if (filter.type && t.type !== filter.type) return false;
      if (filter.status && !statusLower(t.status).includes(filter.status)) return false;
      const date = String(t.date || t.dueDate || t.createdAt || "").slice(0, 10);
      if (filter.start && date && date < filter.start) return false;
      if (filter.end && date && date > filter.end) return false;
      if (filter.text) {
        const call = state.calls[t.callId] || {};
        const vehicle = state.vehicles[t.vehicleId] || {};
        const driver = state.users[t.driverId] || {};
        const haystack = statusLower([
          t.description, t.category, t.status, t.type, t.protocol, t.invoiceNumber,
          t.billingParty, call.protocolo, call.cliente, call.insurance,
          vehicle.placa, vehicle.apelido, driver.nome, driver.email
        ].filter(Boolean).join(" "));
        if (!haystack.includes(filter.text)) return false;
      }
      return true;
    });
    const entradas = rows.filter((t) => t.type === "entrada" && t.module !== "payments_shadow").reduce((s, t) => s + Number(t.amount || 0), 0);
    const saidas = rows.filter((t) => t.type === "saida").reduce((s, t) => s + Number(t.amount || 0), 0);
    const toBill = visibleRows(state.calls).filter((c) => Number(c.valor || 0) > 0 && (isFinalStatus(c.statusKey || c.status) || /faturar|receber/i.test(String(c.billingStatus || ""))) && !c.receivableTransactionId && !c.closingId);
    const billingQueue = toBill.length ? `<div class="workflow-box warn"><b>Chamados finalizados/a faturar sem financeiro oficial</b><div class="table-wrap"><table><thead><tr><th>Chamado</th><th>Cliente/seguradora</th><th>Veículo</th><th>Valor</th><th>Ação</th></tr></thead><tbody>${toBill.map((c) => {
      const vehicle = state.vehicles[c.vehicleId] || {};
      return `<tr><td>${esc(c.protocolo || c.id)}</td><td>${esc(callDisplayName(c))}</td><td>${esc(vehicle.placa || c.vehicleId || "-")}</td><td><b>${money(c.valor || 0)}</b></td><td><button class="btn good" onclick="JM.app.generateCallReceivable('${esc(c.id)}')">Gerar cobrança</button></td></tr>`;
    }).join("")}</tbody></table></div></div>` : "";
    const filterInfo = rows.length === allRows.length ? "" : `<span>Filtrados <b>${rows.length}/${allRows.length}</b></span>`;
    $("financeTable").innerHTML = `<div class="finance-summary"><span>Receitas <b>${money(entradas)}</b></span><span>Despesas <b>${money(saidas)}</b></span><span>Lucro bruto <b>${money(entradas - saidas)}</b></span><span>Registros <b>${rows.length}</b></span>${filterInfo}</div>${billingQueue}<table><thead><tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>Vínculos</th><th>Status</th><th>Valor</th><th>Ações</th></tr></thead><tbody>` +
      rows.map((t) => {
        const call = state.calls[t.callId] || {};
        const vehicle = state.vehicles[t.vehicleId] || {};
        const driver = state.users[t.driverId] || {};
        const paidLine = t.paidAmount != null || t.balanceAmount != null ? `<br><span class="muted small">Pago ${money(t.paidAmount || 0)} · Saldo ${money(t.balanceAmount || 0)}</span>` : "";
        return `<tr><td>${esc(t.date || dateTime(t.createdAt))}<br><span class="muted small">${esc(t.module || t.sourceType || "manual")}</span></td><td>${esc(t.type || "")}</td><td>${esc(t.description || "")}<br><span class="muted small">${esc(t.category || "")}</span></td><td><span class="muted small">${esc(call.protocolo || t.protocol || t.callId || "Sem chamado")}<br>${esc(vehicle.placa || t.vehicleId || "Sem veículo")}<br>${esc(driver.nome || t.driverName || t.driverId || "")}</span></td><td>${esc(t.status || "")}${paidLine}</td><td><b>${money(t.amount || 0)}</b></td><td class="row-actions"><button class="btn" onclick="JM.app.editTransaction('${esc(t.id)}')">Editar</button><button class="btn danger" onclick="JM.app.deleteTransaction('${esc(t.id)}')">Excluir</button></td></tr>`;
      }).join("") +
      `</tbody></table>${reportSignature()}`;
    const pending = visibleRows(state.expenses).filter((e) => e.status === "pendente");
    $("expenseApproval").innerHTML = pending.length ? `<table><thead><tr><th>Motorista</th><th>Vínculos</th><th>Tipo</th><th>Valor</th><th>Obs</th><th>Ações</th></tr></thead><tbody>` +
      pending.map((e) => {
        const call = state.calls[e.callId] || {};
        const vehicle = state.vehicles[e.vehicleId || call.vehicleId] || {};
        return `<tr>
        <td>${esc(e.driverName || e.driverId)}</td><td><span class="muted small">${esc(call.protocolo || e.protocol || e.callId || "Sem chamado")}<br>${esc(vehicle.placa || e.vehicleId || "Sem veículo")}<br>${esc(e.billingParty || callDisplayName(call) || "")}</span></td><td>${esc(e.type || "")}</td><td><b>${money(e.amount || 0)}</b></td>
        <td>${esc(e.notes || "")}${e.photoUrl ? `<br><a class="info" href="${esc(e.photoUrl)}" target="_blank" rel="noopener noreferrer">Comprovante</a>` : ""}</td>
        <td><button class="btn good" onclick="JM.app.approveExpense('${esc(e.id)}')">Aprovar</button><button class="btn danger" onclick="JM.app.rejectExpense('${esc(e.id)}')">Reprovar</button></td>
      </tr>`;
      }).join("") + `</tbody></table>` : `<p class="muted">Sem despesas pendentes de aprovação.</p>`;
  }

  $("financeForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!canManageFinance()) return toast("Somente gestor/dono ou financeiro pode lançar.", "danger");
    const callId = $("finCall") ? $("finCall").value : "";
    const call = callId ? await getDocData("calls", callId, state.calls) : null;
    let payload = {
      type: $("finType").value,
      date: $("finDate").value,
      description: $("finDesc").value.trim(),
      amount: parseMoney($("finAmount").value),
      status: $("finStatus").value,
      category: $("finCategory") ? $("finCategory").value.trim() : "",
      customerId: $("finCustomer") ? $("finCustomer").value : "",
      callId,
      vehicleId: $("finVehicle") ? $("finVehicle").value : "",
      driverId: $("finDriver") ? $("finDriver").value : "",
      module: "manual_finance",
      sourceType: "manual_finance",
      updatedAt: new Date().toISOString(),
      updatedBy: state.user.uid
    };
    payload = enrichFinancialPayloadFromCall(payload, call);
    let savedId = state.editingTransactionId;
    if (savedId) {
      await db.collection("transactions").doc(savedId).set(payload, { merge: true });
      toast("Lançamento atualizado e vínculos recalculados.", "ok");
    } else {
      const ref = await db.collection("transactions").add(Object.assign({ createdAt: new Date().toISOString(), createdBy: state.user.uid }, payload));
      savedId = ref.id;
      toast("Lançamento salvo e vinculado automaticamente.", "ok");
    }
    if (payload.callId) await recalculateCallFinancials(payload.callId);
    resetFinanceForm();
  };

  function renderPayments() {
    if (!$("paymentsTable")) return;
    if (!canManageFinance()) {
      $("paymentsTable").innerHTML = `<p class="muted">Gestão de pagamentos disponível somente para gestor/dono e financeiro.</p>`;
      return;
    }
    const filter = {
      text: statusLower($("paymentSearch") && $("paymentSearch").value || ""),
      type: $("paymentTypeFilter") && $("paymentTypeFilter").value || "",
      status: statusLower($("paymentStatusFilter") && $("paymentStatusFilter").value || "")
    };
    const rows = visibleRows(state.transactions)
      .filter((t) => t.module === "payments" || t.customerId || t.billingParty)
      .filter((t) => {
        if (filter.type && t.type !== filter.type) return false;
        if (filter.status && !statusLower(t.status).includes(filter.status)) return false;
        if (filter.text) {
          const customer = state.customers[t.customerId] || {};
          const call = state.calls[t.callId] || {};
          const haystack = statusLower([
            t.description, t.invoiceNumber, t.category, t.billingParty, t.status,
            customer.name, call.protocolo, call.cliente, call.insurance, t.callId
          ].filter(Boolean).join(" "));
          if (!haystack.includes(filter.text)) return false;
        }
        return true;
      })
      .sort((a, b) => String(b.dueDate || b.date || b.createdAt || "").localeCompare(String(a.dueDate || a.date || a.createdAt || "")));
    const receber = rows.filter((t) => t.type === "entrada" && !statusMeansReceived(t.status)).reduce((s, t) => s + Number(t.balanceAmount != null ? t.balanceAmount : t.amount || 0), 0);
    const pagar = rows.filter((t) => t.type === "saida" && !statusMeansReceived(t.status)).reduce((s, t) => s + Number(t.amount || 0), 0);
    const today = todayInput();
    const vencidos = rows.filter((t) => t.type === "entrada" && !statusMeansReceived(t.status) && t.dueDate && t.dueDate < today).reduce((s, t) => s + Number(t.balanceAmount != null ? t.balanceAmount : t.amount || 0), 0);
    const glosados = rows.filter((t) => /glos/i.test(String(t.status || ""))).reduce((s, t) => s + Number(t.amount || 0), 0);
    $("paymentsSummary").innerHTML = `<div class="finance-summary"><span>A receber <b>${money(receber)}</b></span><span>A pagar <b>${money(pagar)}</b></span><span>Vencidos <b>${money(vencidos)}</b></span><span>Glosados <b>${money(glosados)}</b></span><span>Registros <b>${rows.length}</b></span></div>`;
    $("paymentsTable").innerHTML = rows.length ? `<table><thead><tr><th>Vencimento</th><th>Cliente/seguradora</th><th>Documento</th><th>Status</th><th>Valor</th><th>Ações</th></tr></thead><tbody>` + rows.map((p) => {
      const customer = state.customers[p.customerId] || {};
      return `<tr>
        <td>${esc(p.dueDate || p.date || "")}<br><span class="muted small">${esc(p.paymentMethod || "")}</span></td>
        <td><b>${esc(customer.name || p.billingParty || "")}</b><br><span class="muted small">${esc(p.category || "")}</span></td>
        <td>${esc(p.invoiceNumber || p.description || "")}<br><span class="muted small">${esc(p.callId || "")}</span></td>
        <td><span class="badge ${statusMeansReceived(p.status) ? "ok" : "warn"}">${esc(p.status || "")}</span>${p.paidAmount != null || p.balanceAmount != null ? `<br><span class="muted small">Pago ${money(p.paidAmount || 0)} · Saldo ${money(p.balanceAmount || 0)}</span>` : ""}</td>
        <td><b>${money(p.amount || 0)}</b></td>
        <td class="row-actions"><button class="btn" onclick="JM.app.editPayment('${esc(p.id)}')">Editar</button><button class="btn danger" onclick="JM.app.deleteTransaction('${esc(p.id)}')">Excluir</button></td>
      </tr>`;
    }).join("") + `</tbody></table>` : `<p class="muted">Nenhum pagamento cadastrado para clientes/seguradoras.</p>`;
  }

  function closingMonth(call) {
    return String(call.closedAt || call.finalizedAt || call.updatedAt || call.createdAt || todayInput()).slice(0, 7) || todayInput().slice(0, 7);
  }

  function closingParty(call) {
    return call.insurance || call.billingParty || callDisplayName(call) || "Sem seguradora";
  }

  function closingCandidate(call) {
    if (!call || call.deletedAt || !isFinalStatus(call)) return false;
    if (!Number(call.valor || 0)) return false;
    if (call.closingId || statusMeansReceived(call.billingStatus)) return false;
    const party = closingParty(call);
    return !!String(party || "").trim();
  }

  function buildInsuranceClosingGroups() {
    const search = statusLower($("closingSearch") && $("closingSearch").value || "");
    const monthFilter = $("closingMonthFilter") && $("closingMonthFilter").value || "";
    const groups = {};
    visibleRows(state.calls).filter(closingCandidate).forEach((call) => {
      const month = closingMonth(call);
      if (monthFilter && month !== monthFilter) return;
      if (search && !callSearchText(call).includes(search) && !statusLower(closingParty(call)).includes(search)) return;
      const party = closingParty(call);
      const key = uidSafe(statusLower(party) + "-" + month);
      if (!groups[key]) {
        groups[key] = { key, party, month, calls: [], total: 0, customerId: call.customerId || "", proofPending: 0 };
      }
      groups[key].calls.push(call);
      groups[key].total += Number(call.valor || 0);
      if (!callProofComplete(call)) groups[key].proofPending += 1;
      if (!groups[key].customerId && call.customerId) groups[key].customerId = call.customerId;
    });
    state.insuranceClosingGroups = groups;
    return Object.values(groups).sort((a, b) => String(b.month).localeCompare(String(a.month)) || String(a.party).localeCompare(String(b.party)));
  }

  function renderInsuranceClosings() {
    if (!$("insuranceClosingTable")) return;
    if (!canManageFinance()) {
      $("insuranceClosingSummary").innerHTML = "";
      $("insuranceClosingTable").innerHTML = `<p class="muted">Fechamento disponível somente para gestor/dono e financeiro.</p>`;
      $("insuranceClosingReview").innerHTML = "";
      return;
    }
    const groups = buildInsuranceClosingGroups();
    const total = groups.reduce((sum, group) => sum + group.total, 0);
    const callsCount = groups.reduce((sum, group) => sum + group.calls.length, 0);
    $("insuranceClosingSummary").innerHTML = `<div class="finance-summary"><span>Seguradoras <b>${groups.length}</b></span><span>Chamados <b>${callsCount}</b></span><span>Total a fechar <b>${money(total)}</b></span></div>`;
    $("insuranceClosingTable").innerHTML = groups.length ? `<table><thead><tr><th>Seguradora</th><th>Mês</th><th>Chamados</th><th>Provas</th><th>Total</th><th>Ações</th></tr></thead><tbody>` + groups.map((group) => {
      const pending = group.proofPending ? `<span class="badge warn">${group.proofPending} pendente(s)</span>` : `<span class="badge ok">completo</span>`;
      const sample = group.calls.slice(0, 4).map((call) => call.protocolo || call.id).join(", ");
      return `<tr>
        <td><b>${esc(group.party)}</b><br><span class="muted small">${esc(sample)}${group.calls.length > 4 ? "..." : ""}</span></td>
        <td>${esc(group.month)}</td>
        <td>${group.calls.length}</td>
        <td>${pending}</td>
        <td><b>${money(group.total)}</b></td>
        <td class="row-actions"><button class="btn primary" onclick="JM.app.previewInsuranceClosing('${esc(group.key)}')">Revisar</button></td>
      </tr>`;
    }).join("") + `</tbody></table>` : `<p class="muted">Nenhum chamado finalizado pendente de fechamento para os filtros atuais.</p>`;
  }

  function previewInsuranceClosing(key) {
    if (!canManageFinance()) return toast("Sem permissão para fechar seguradoras.", "danger");
    const group = state.insuranceClosingGroups[key] || buildInsuranceClosingGroups().find((row) => row.key === key);
    const box = $("insuranceClosingReview");
    if (!group || !box) return toast("Fechamento não encontrado no filtro atual.", "danger");
    const rows = group.calls.map((call) => {
      const vehicle = state.vehicles[call.vehicleId] || {};
      return `<tr><td>${esc(call.protocolo || call.id)}<br><span class="muted small">${esc(call.cliente || "")}</span></td><td>${esc(vehicle.placa || call.customerPlate || "-")}</td><td>${proofStatusBadge(call)}</td><td><b>${money(call.valor || 0)}</b></td><td><button class="btn" onclick="JM.app.selectCallDossier('${esc(call.id)}')">Abrir</button></td></tr>`;
    }).join("");
    box.innerHTML = `<div class="closing-card">
      <div class="closing-card-header">
        <div><h3>Revisão do fechamento</h3><p class="muted small">${esc(group.party)} · ${esc(group.month)} · ${group.calls.length} chamado(s)</p></div>
        <span class="badge ${group.proofPending ? "warn" : "ok"}">${group.proofPending ? group.proofPending + " prova(s) pendente(s)" : "pronto"}</span>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Chamado</th><th>Veículo</th><th>Provas</th><th>Valor</th><th>Ação</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="actions" style="justify-content:space-between;margin-top:12px">
        <b>Total: ${money(group.total)}</b>
        <button class="btn good" onclick="JM.app.saveInsuranceClosing('${esc(group.key)}')">Salvar fechamento</button>
      </div>
    </div>`;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function saveInsuranceClosing(key) {
    if (!canManageFinance()) return toast("Sem permissão para salvar fechamento.", "danger");
    const group = state.insuranceClosingGroups[key] || buildInsuranceClosingGroups().find((row) => row.key === key);
    if (!group) return toast("Fechamento não encontrado.", "danger");
    if (!group.calls.length) return toast("Nenhum chamado no fechamento.", "warn");
    if (group.proofPending && !window.confirm("Existem provas pendentes neste fechamento. Deseja salvar mesmo assim?")) return;
    const now = new Date().toISOString();
    const callsWithoutReceivable = group.calls.filter((call) => !call.receivableTransactionId);
    const newAmount = callsWithoutReceivable.reduce((sum, call) => sum + Number(call.valor || 0), 0);
    const closingPayload = {
      module: "insurance_closing",
      sourceType: "insurance_closing",
      type: "entrada",
      date: todayInput(),
      dueDate: todayInput(),
      description: `Fechamento ${group.party} - ${group.month}`,
      amount: newAmount || group.total,
      paidAmount: 0,
      balanceAmount: newAmount || group.total,
      status: "A receber",
      paymentMethod: "Faturamento seguradora",
      category: "Fechamento seguradora",
      customerId: group.customerId || "",
      billingParty: group.party,
      callIds: group.calls.map((call) => call.id),
      protocol: group.calls.map((call) => call.protocolo || call.id).join(", "),
      groupedTotal: group.total,
      createdAt: now,
      createdBy: state.user.uid,
      updatedAt: now,
      updatedBy: state.user.uid
    };
    const ref = callsWithoutReceivable.length
      ? await db.collection("transactions").add(closingPayload)
      : { id: uidSafe("fechamento-" + group.party + "-" + group.month + "-" + Date.now()) };
    const batch = db.batch();
    group.calls.forEach((call) => {
      batch.set(db.collection("calls").doc(call.id), {
        closingId: ref.id,
        closingMonth: group.month,
        closingParty: group.party,
        closingStatus: "fechado",
        billingStatus: "fechado_a_receber",
        financePending: false,
        updatedAt: now,
        updatedBy: state.user.uid,
        timeline: arrayUnion({ at: now, by: personName(), text: "Chamado incluído no fechamento " + group.party + " - " + group.month })
      }, { merge: true });
      if (call.receivableTransactionId) {
        batch.set(db.collection("transactions").doc(call.receivableTransactionId), {
          closingId: ref.id,
          closingMonth: group.month,
          closingParty: group.party,
          billingParty: group.party,
          category: "Fechamento seguradora",
          updatedAt: now,
          updatedBy: state.user.uid
        }, { merge: true });
      }
    });
    await batch.commit();
    $("insuranceClosingReview").innerHTML = "";
    toast("Fechamento salvo no financeiro e vinculado aos chamados.", "ok");
  }

  function fillPaymentFromCall() {
    const callId = $("payCall") && $("payCall").value;
    const call = callId && state.calls[callId];
    if (!call) return;
    const customer = call.customerId && state.customers[call.customerId] || null;
    setValue("payCustomer", call.customerId || "");
    setValue("payBillingParty", customer && customer.name || callDisplayName(call));
    if (!$("payDescription").value) setValue("payDescription", `Recebimento chamado ${callProtocolLabel(call, callId)} - ${callDisplayName(call)}`);
    if (!$("payCategory").value) setValue("payCategory", call.insurance ? "Seguradora" : "Receita de chamado");
    if (!parseMoney($("payAmount").value)) setValue("payAmount", call.balanceAmount || call.valor || "");
    if ($("payStatus") && (!$("payStatus").value || $("payStatus").value === "A receber")) setValue("payStatus", "Recebido");
    toast("Dados do chamado puxados para o recebimento.", "ok");
  }

  function fillFinanceFromCall() {
    const callId = $("finCall") && $("finCall").value;
    const call = callId && state.calls[callId];
    if (!call) return;
    setValue("finCustomer", call.customerId || "");
    setValue("finVehicle", call.vehicleId || "");
    setValue("finDriver", call.driverId || "");
    if (!$("finDesc").value) setValue("finDesc", `Chamado ${callProtocolLabel(call, callId)} - ${callDisplayName(call)}`);
    if (!$("finCategory").value) setValue("finCategory", call.insurance ? "Seguradora" : "Receita de chamado");
    if (!parseMoney($("finAmount").value)) setValue("finAmount", call.valor || "");
    toast("Chamado vinculado: veículo, motorista e cliente preenchidos.", "ok");
  }

  $("paymentForm") && ($("paymentForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!canManageFinance()) return toast("Somente gestor/dono ou financeiro pode gerir pagamentos.", "danger");
    const customer = $("payCustomer").value ? state.customers[$("payCustomer").value] || null : null;
    const callId = $("payCall").value;
    const call = callId ? await getDocData("calls", callId, state.calls) : null;
    let payload = {
      module: "payments",
      sourceType: "payment",
      type: $("payType").value,
      date: $("payDate").value || todayInput(),
      dueDate: $("payDueDate").value || $("payDate").value || todayInput(),
      description: $("payDescription").value.trim(),
      amount: parseMoney($("payAmount").value),
      status: $("payStatus").value,
      paymentMethod: $("payMethod").value,
      invoiceNumber: $("payInvoice").value.trim(),
      category: $("payCategory").value.trim(),
      customerId: $("payCustomer").value,
      billingParty: customer && customer.name || $("payBillingParty").value.trim(),
      callId,
      updatedAt: new Date().toISOString(),
      updatedBy: state.user.uid
    };
    payload = enrichFinancialPayloadFromCall(payload, call);
    if (!payload.billingParty && !payload.customerId && !payload.callId) return toast("Selecione ou informe quem vai pagar/receber.", "danger");

    if (payload.callId && payload.type === "entrada") {
      const txId = await upsertCallReceivable(payload.callId, {
        date: payload.date,
        dueDate: payload.dueDate,
        description: payload.description || undefined,
        amount: payload.amount,
        paidAmount: statusMeansReceived(payload.status) ? payload.amount : 0,
        status: payload.status,
        paymentMethod: payload.paymentMethod,
        invoiceNumber: payload.invoiceNumber,
        category: payload.category || "Receita de chamado"
      });
      state.editingPaymentId = txId || state.editingPaymentId;
      toast("Recebimento salvo no financeiro e no chamado, sem lançar duas vezes.", "ok");
    } else if (state.editingPaymentId) {
      await db.collection("transactions").doc(state.editingPaymentId).set(payload, { merge: true });
      if (payload.callId) await recalculateCallFinancials(payload.callId);
      toast("Pagamento atualizado e vínculos recalculados.", "ok");
    } else {
      const ref = await db.collection("transactions").add(Object.assign({ createdAt: new Date().toISOString(), createdBy: state.user.uid }, payload));
      if (payload.callId) await recalculateCallFinancials(payload.callId);
      state.editingPaymentId = ref.id;
      toast("Pagamento cadastrado e vinculado automaticamente.", "ok");
    }
    resetPaymentForm();
  });

  async function generateCallReceivable(id) {
    if (!canManageFinance()) return toast("Somente gestor/dono ou financeiro pode gerar cobrança.", "danger");
    const txId = await upsertCallReceivable(id, { status: "A receber" });
    if (txId) toast("Cobrança do chamado gerada no financeiro e em pagamentos.", "ok");
  }

  function editPayment(id) {
    const tx = state.transactions[id];
    if (!tx || !canManageFinance()) return;
    state.editingPaymentId = id;
    showView("pagamentos");
    setValue("payType", tx.type || "entrada");
    setValue("payDate", tx.date || todayInput());
    setValue("payDueDate", tx.dueDate || tx.date || todayInput());
    setValue("payCustomer", tx.customerId || "");
    setValue("payBillingParty", tx.billingParty || "");
    setValue("payCall", tx.callId || "");
    setValue("payDescription", tx.description || "");
    setValue("payInvoice", tx.invoiceNumber || "");
    setValue("payCategory", tx.category || "");
    setValue("payMethod", tx.paymentMethod || "PIX");
    setValue("payStatus", tx.status || "A receber");
    setValue("payAmount", tx.amount || "");
    setSubmitText("paymentForm", "Salvar alterações do pagamento");
    if ($("paymentCancelEdit")) $("paymentCancelEdit").classList.remove("hidden");
  }

  function editTransaction(id) {
    if (!canManageFinance()) return toast("Sem permissão para editar financeiro.", "danger");
    const tx = state.transactions[id];
    if (!tx) return toast("Lançamento não encontrado.", "danger");
    state.editingTransactionId = id;
    setValue("finType", tx.type || "entrada");
    setValue("finDate", tx.date || todayInput());
    setValue("finDesc", tx.description || "");
    setValue("finAmount", tx.amount || "");
    setValue("finStatus", tx.status || "Pendente");
    setValue("finCategory", tx.category || "");
    setValue("finCustomer", tx.customerId || "");
    setValue("finCall", tx.callId || "");
    setValue("finVehicle", tx.vehicleId || "");
    setValue("finDriver", tx.driverId || "");
    setSubmitText("financeForm", "Salvar alterações financeiras");
    if ($("financeCancelEdit")) $("financeCancelEdit").classList.remove("hidden");
  }

  async function deleteTransaction(id) {
    if (!canOwnCompany()) return toast("Somente gestor/dono pode excluir financeiro.", "danger");
    const tx = state.transactions[id];
    if (!tx) return toast("Lançamento não encontrado.", "danger");
    const reason = window.prompt("Motivo para excluir o lançamento financeiro:", "Correção financeira");
    if (reason === null) return;
    await softDeleteDoc("transactions", id, tx, reason);
    if (tx.callId) await recalculateCallFinancials(tx.callId);
    if (state.editingTransactionId === id) resetFinanceForm();
    if (state.editingPaymentId === id) resetPaymentForm();
    toast("Lançamento removido do painel com auditoria e vínculos recalculados.", "ok");
  }

  async function approveExpense(id) {
    const expense = state.expenses[id];
    if (!expense || !canManageFinance()) return;
    await upsertTransactionFromExpense(id, expense);
    toast("Despesa aprovada, vinculada ao chamado/veículo e refletida no financeiro.", "ok");
  }

  async function rejectExpense(id) {
    if (!canManageFinance()) return;
    await db.collection("expenses").doc(id).update({ status: "reprovado", rejectedAt: new Date().toISOString(), rejectedBy: state.user.uid });
    toast("Despesa reprovada.", "ok");
  }

  function refreshMaps() {
    const active = document.querySelector(".view.active");
    window.JM_MAP_SETTINGS = activeMapSettings();
    const vehicles = Object.fromEntries(visibleRows(state.vehicles).map(vehicleWithLiveGps).map((v) => [v.id, v]));
    if (window.JM.tracker && typeof window.JM.tracker.getNormalizedFleetPositions === "function") {
      const normalized = window.JM.tracker.getNormalizedFleetPositions(vehicles, state.mobileGps && state.mobileGps.vehicles || {});
      normalized.forEach((pos) => {
        if (!pos || !pos.vehicleId || !vehicles[pos.vehicleId]) return;
        const current = vehicles[pos.vehicleId];
        vehicles[pos.vehicleId] = Object.assign({}, current, {
          location: { lat: pos.lat, lng: pos.lng },
          gpsSource: pos.source || current.gpsSource || "tracker",
          trackerStatus: pos.providerType ? ("Tracker " + pos.providerType) : current.trackerStatus,
          trackerProviderId: pos.providerId || current.trackerProviderId || "",
          trackerProviderType: pos.providerType || current.trackerProviderType || "",
          lastTrackerAt: pos.updatedAt || current.lastTrackerAt || current.updatedAt
        });
      });
    }
    appendMobileGpsSideMarkers(vehicles);
    const calls = Object.fromEntries(visibleRows(state.calls).map((c) => [c.id, c]));
    if (!active) return;
    if (active.id === "view-dashboard") window.JM.mapa.renderFleetMap("dashboardMap", vehicles, calls);
    if (active.id === "view-operacao") window.JM.mapa.renderFleetMap("operationMap", vehicles, calls, { selectedCallId: state.selectedCallId, selectedVehicleId: state.selectedVehicleId, filter: state.operationFilter || "ativos" });
    if (active.id === "view-mapa") window.JM.mapa.renderFleetMap("fleetMap", vehicles, calls);
  }

  function registerFreshServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("service-worker.js?v=" + LOGIN_FLOW_VERSION).catch(() => {});
  }

  function bindRouteButtons() {
    if ($("btnGeocodeOrigin")) $("btnGeocodeOrigin").onclick = () => geocodeAddress("origin");
    if ($("btnGeocodeDest")) $("btnGeocodeDest").onclick = () => geocodeAddress("destination");
    if ($("btnOpenOriginGoogle")) $("btnOpenOriginGoogle").onclick = () => openAddressInGoogle("origin");
    if ($("btnOpenDestGoogle")) $("btnOpenDestGoogle").onclick = () => openAddressInGoogle("destination");
    if ($("btnUseCurrentLocation")) $("btnUseCurrentLocation").onclick = useCurrentLocationAsOrigin;
    if ($("btnSmartRoute")) $("btnSmartRoute").onclick = calculateSmartRoute;
    if ($("btnRoutePricingRecalc")) $("btnRoutePricingRecalc").onclick = calculateSmartRoute;
    if ($("btnOpenGoogleRoute")) $("btnOpenGoogleRoute").onclick = openGoogleRouteFromForm;
    if ($("btnReadRouteLink")) $("btnReadRouteLink").onclick = readSharedRouteLink;
    if ($("btnTowUseRouteKm")) $("btnTowUseRouteKm").onclick = applyRouteKmToTowPricing;
    if ($("btnUseSuggestedPrice")) $("btnUseSuggestedPrice").onclick = applySuggestedPriceToForm;
    if ($("btnTowApplyToPrice")) $("btnTowApplyToPrice").onclick = applyTowTotalToPrice;
    if ($("callVehicle")) $("callVehicle").onchange = () => {
      const driverId = driverIdFromVehicle(state.vehicles[$("callVehicle").value] || null);
      if (driverId && $("callDriver") && !$("callDriver").value) setValue("callDriver", driverId);
    };
    ["callTowActive", "callTowKm", "callTowFranchiseKm", "callTowBaseOut", "callTowKmValue", "callTowDiscountPct", "callTowTollOneWay", "callTowRoundTrip", "callTowSubtractFranchise", "callTowTollRoundTrip", "callTowNotes"].forEach((id) => {
      const handler = () => {
        calculateTowPricing();
        if (state.routePricing) calculateCurrentRoutePricing({ syncTowForm: false, autoFill: false });
      };
      if ($(id)) $(id).oninput = handler;
      if ($(id)) $(id).onchange = handler;
    });
    if ($("callTowType")) $("callTowType").onchange = () => {
      updateTowDefaultsByType();
      if (state.routePricing) calculateCurrentRoutePricing({ syncTowForm: false, autoFill: false });
    };
    if ($("btnSyncTrackerNow")) $("btnSyncTrackerNow").onclick = () => syncTrackerNow(true);
    if ($("aiSourceFile")) $("aiSourceFile").onchange = previewAiFile;
    if ($("btnAiExtract")) $("btnAiExtract").onclick = extractAiFileText;
    if ($("btnAiAnalyze")) $("btnAiAnalyze").onclick = analyzeAiInput;
    if ($("btnAiClear")) $("btnAiClear").onclick = () => {
      if ($("aiSourceFile")) $("aiSourceFile").value = "";
      if ($("aiSourceText")) $("aiSourceText").value = "";
      state.aiDrafts = [];
      previewAiFile();
      renderAiReview();
      aiSetStatus("O salvamento só acontece depois da revisão.", "muted");
    };
    if ($("callCancelEdit")) $("callCancelEdit").onclick = resetCallForm;
    if ($("teamCancelEdit")) $("teamCancelEdit").onclick = resetTeamForm;
    if ($("financeCancelEdit")) $("financeCancelEdit").onclick = resetFinanceForm;
    if ($("paymentCancelEdit")) $("paymentCancelEdit").onclick = resetPaymentForm;
    if ($("customerCancelEdit")) $("customerCancelEdit").onclick = resetCustomerForm;
    if ($("maintenanceCancelEdit")) $("maintenanceCancelEdit").onclick = resetMaintenanceForm;
    if ($("payCall")) $("payCall").onchange = fillPaymentFromCall;
    if ($("finCall")) $("finCall").onchange = fillFinanceFromCall;
    ["callsSearch", "callsStatusFilter", "callsSourceFilter"].forEach((id) => {
      if ($(id)) $(id).oninput = renderCalls;
      if ($(id)) $(id).onchange = renderCalls;
    });
    if ($("callsClearFilters")) $("callsClearFilters").onclick = () => {
      ["callsSearch", "callsStatusFilter", "callsSourceFilter"].forEach((id) => { if ($(id)) $(id).value = ""; });
      renderCalls();
    };
    ["finalizedSearch", "finalizedBillingFilter"].forEach((id) => {
      if ($(id)) $(id).oninput = renderFinalizedCalls;
      if ($(id)) $(id).onchange = renderFinalizedCalls;
    });
    if ($("finalizedClearFilters")) $("finalizedClearFilters").onclick = () => {
      ["finalizedSearch", "finalizedBillingFilter"].forEach((id) => { if ($(id)) $(id).value = ""; });
      renderFinalizedCalls();
    };
    ["financeSearch", "financeTypeFilter", "financeStatusFilter", "financeStartDate", "financeEndDate"].forEach((id) => {
      if ($(id)) $(id).oninput = renderFinance;
      if ($(id)) $(id).onchange = renderFinance;
    });
    if ($("financeClearFilters")) $("financeClearFilters").onclick = () => {
      ["financeSearch", "financeTypeFilter", "financeStatusFilter", "financeStartDate", "financeEndDate"].forEach((id) => {
        if ($(id)) $(id).value = "";
      });
      renderFinance();
    };
    ["paymentSearch", "paymentTypeFilter", "paymentStatusFilter"].forEach((id) => {
      if ($(id)) $(id).oninput = renderPayments;
      if ($(id)) $(id).onchange = renderPayments;
    });
    if ($("paymentClearFilters")) $("paymentClearFilters").onclick = () => {
      ["paymentSearch", "paymentTypeFilter", "paymentStatusFilter"].forEach((id) => { if ($(id)) $(id).value = ""; });
      renderPayments();
    };
    ["closingSearch", "closingMonthFilter"].forEach((id) => {
      if ($(id)) $(id).oninput = () => { renderInsuranceClosings(); if ($("insuranceClosingReview")) $("insuranceClosingReview").innerHTML = ""; };
      if ($(id)) $(id).onchange = () => { renderInsuranceClosings(); if ($("insuranceClosingReview")) $("insuranceClosingReview").innerHTML = ""; };
    });
    if ($("closingClearFilters")) $("closingClearFilters").onclick = () => {
      ["closingSearch", "closingMonthFilter"].forEach((id) => { if ($(id)) $(id).value = ""; });
      if ($("insuranceClosingReview")) $("insuranceClosingReview").innerHTML = "";
      renderInsuranceClosings();
    };
  }

  function boot() {
    bindNavigation();
    bindSidebarAndMapControls();
    bindRouteButtons();
    bindInputMasks();
    renderSmartRouteBox();
    initializeAddressTools();
    if (typeof setupCollapsiblePanels === "function") {
      setupCollapsiblePanels(document, { collapseOnMobile: true, openFirst: 2 });
      setTimeout(() => setupCollapsiblePanels(document, { collapseOnMobile: true, openFirst: 2 }), 250);
      window.addEventListener("load", () => setupCollapsiblePanels(document, { collapseOnMobile: true, openFirst: 2 }), { once: true });
    }
    if ($("finDate")) $("finDate").value = todayInput();
    if ($("payDate")) $("payDate").value = todayInput();
    if ($("maintenanceDate")) $("maintenanceDate").value = todayInput();
    console.info("JM Guinchos login flow", LOGIN_FLOW_VERSION);
    registerFreshServiceWorker();
  }

  window.JM = window.JM || {};
  window.JM.app = {
    setCallStatus,
    selectOperationalCall,
    selectOperationalVehicle,
    assignSelectedVehicleToSelectedCall,
    openSelectedCallRoute,
    copySelectedCallRoute,
    editCall,
    deleteCall,
    viewCallProofs,
    reviewCallProofs,
    generatePublicLink,
    copyPublicLink,
    openPublicView,
    revokePublicLink,
    togglePublicProofs,
    togglePublicPayment,
    openReport,
    replyPublicChat,
    markPublicChatRead,
    selectCallDossier,
    reopenCall,
    editTeamMember,
    deleteTeamMember,
    editTransaction,
    editPayment,
    generateCallReceivable,
    previewInsuranceClosing,
    saveInsuranceClosing,
    deleteTransaction,
    editCustomer,
    deleteCustomer,
    applyIntegrationToCall,
    markIntegrationHandled,
    editMaintenance,
    deleteMaintenance,
    approveExpense,
    rejectExpense,
    applySmartVehicle,
    applyAiDraft,
    saveAiDraft,
    buildAiDraftsFromText: buildAiDrafts,
    calculateSmartRoute,
    readSharedRouteLink,
    calculateRoutePricing,
    findTollsAlongRoute,
    distancePointToRouteMeters,
    applyPricingToCall,
    formatPricingSummary,
    preserveManualPrice,
    syncTrackerNow,
    state
  };
  boot();
}());
