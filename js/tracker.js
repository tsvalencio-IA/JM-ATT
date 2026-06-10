(function () {
  "use strict";

  const { plateKey } = window.JM.utils;

  function joinUrl(base, path) {
    const b = String(base || "").replace(/\/+$/, "");
    const p = String(path || "").replace(/^\/+/, "");
    return b ? b + "/" + p : p;
  }

  function trackerHeaders(config) {
    const headers = { "Accept": "application/json" };
    if (config && config.token) {
      headers[config.tokenHeader || "Authorization"] = String(config.tokenPrefix == null ? "Bearer " : config.tokenPrefix) + config.token;
    }
    return headers;
  }

  async function fetchJson(url, headers) {
    let response;
    try {
      response = await fetch(url, { method: "GET", headers, cache: "no-store" });
    } catch (err) {
      if (err && (err.name === "TypeError" || /failed to fetch|network/i.test(err.message || ""))) {
        throw new Error("O navegador bloqueou a chamada ao Tracker. Provável CORS/preflight na plataforma RAFA; sem backend/proxy, o painel só consegue sincronizar se o endpoint liberar Authorization para este domínio.");
      }
      throw err;
    }
    if (!response.ok) throw new Error(url + " retornou HTTP " + response.status);
    return response.json();
  }

  function flattenTrackerPayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== "object") return [];
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.vehicles)) return payload.vehicles;
    if (Array.isArray(payload.veiculos)) return payload.veiculos;
    if (Array.isArray(payload.positions)) return payload.positions;
    if (Array.isArray(payload.posicoes)) return payload.posicoes;
    if (Array.isArray(payload.devices)) return payload.devices;
    return Object.values(payload).filter((v) => v && typeof v === "object");
  }

  function makeDeviceMap(devicesPayload) {
    const map = {};
    flattenTrackerPayload(devicesPayload).forEach((device) => {
      if (!device || typeof device !== "object") return;
      const keys = [device.id, device.deviceId, device.uniqueId, device.imei, device.name, device.placa, device.plate].filter(Boolean);
      keys.forEach((k) => { map[String(k)] = device; });
    });
    return map;
  }

  function normalizeProvider(provider) {
    return Object.assign({
      providerId: "",
      name: "",
      providerType: "rafa",
      active: true,
      priority: 50,
      tokenHeader: "Authorization",
      tokenPrefix: "Bearer ",
      pollingMs: 30000,
      timeoutMs: 15000
    }, provider || {});
  }

  function normalizePosition(raw, deviceMap, provider) {
    provider = normalizeProvider(provider || {});
    const lat = Number(raw.lat ?? raw.latitude ?? raw.y ?? raw.Latitude);
    const lng = Number(raw.lng ?? raw.lon ?? raw.longitude ?? raw.x ?? raw.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const device = deviceMap && (deviceMap[String(raw.deviceId)] || deviceMap[String(raw.trackerId)] || deviceMap[String(raw.id)] || deviceMap[String(raw.uniqueId)] || deviceMap[String(raw.imei)]) || {};
    const name = raw.placa || raw.plate || raw.name || raw.vehicle || raw.deviceName || raw.device || raw.identificacao || device.name || device.placa || device.plate || device.uniqueId || raw.deviceId || raw.id;
    const plate = plateKey(name);
    const trackerId = String(raw.trackerId || raw.deviceId || raw.uniqueId || raw.imei || device.uniqueId || device.id || raw.id || plate || "");
    const attrs = raw.attributes || raw.attrs || {};
    return {
      plate,
      trackerId,
      deviceId: raw.deviceId || device.id || "",
      deviceName: device.name || raw.deviceName || raw.name || "",
      uniqueId: device.uniqueId || raw.uniqueId || raw.imei || "",
      lat,
      lng,
      speed: Number(raw.speed ?? raw.velocidade ?? attrs.speed ?? 0) || 0,
      ignition: Boolean(raw.ignition ?? raw.ignicao ?? raw.acc ?? attrs.ignition ?? attrs.ignicao ?? false),
      rawStatus: raw.status || raw.situacao || attrs.status || "online",
      address: raw.address || "",
      providerId: provider.id || provider.providerId || "",
      providerType: provider.providerType || "rafa",
      source: provider.providerType || "tracker",
      capturedAt: raw.fixTime || raw.deviceTime || raw.serverTime || raw.timestamp || raw.time || raw.dataHora || new Date().toISOString()
    };
  }

  async function fetchTrackerPositions(config) {
    config = normalizeProvider(config);
    if (!config || !config.endpoint || !config.token) return [];
    const endpoint = String(config.endpoint || "").replace(/\/+$/, "");
    const headers = trackerHeaders(config);
    let devicesPayload = [];
    let positionsPayload = [];
    const looksLikePositions = /\/positions(?:\?|$)/i.test(endpoint);

    if (looksLikePositions) {
      positionsPayload = await fetchJson(endpoint, headers);
    } else {
      try { devicesPayload = await fetchJson(joinUrl(endpoint, "devices"), headers); } catch (err) { console.warn("Falha ao buscar devices", err); }
      try {
        positionsPayload = await fetchJson(joinUrl(endpoint, "positions"), headers);
      } catch (err) {
        console.warn("Falha ao buscar positions; tentando endpoint bruto", err);
        positionsPayload = await fetchJson(endpoint, headers);
      }
    }

    const deviceMap = makeDeviceMap(devicesPayload);
    return flattenTrackerPayload(positionsPayload).map((p) => normalizePosition(p, deviceMap, config)).filter(Boolean);
  }

  function cleanKey(value) {
    return String(value == null ? "" : value).toLowerCase().trim();
  }

  function idSafe(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9_-]+/g, "").slice(0, 40);
  }

  function vehicleKeys(id, vehicle) {
    const values = [
      id,
      vehicle && vehicle.id,
      vehicle && vehicle.placa,
      vehicle && vehicle.trackerId,
      vehicle && vehicle.trackerDeviceId,
      vehicle && vehicle.trackerExternalId,
      vehicle && vehicle.trackerImei,
      vehicle && vehicle.trackerPlate,
      vehicle && vehicle.trackerName,
      vehicle && vehicle.trackerUniqueId,
      vehicle && vehicle.uniqueId,
      vehicle && vehicle.deviceId,
      vehicle && vehicle.deviceName,
      vehicle && vehicle.apelido
    ];
    if (vehicle && Array.isArray(vehicle.trackerIds)) values.push(...vehicle.trackerIds);
    return values.map(cleanKey).filter(Boolean);
  }

  function positionKeys(pos) {
    return [
      pos && pos.plate,
      pos && pos.trackerId,
      pos && pos.deviceId,
      pos && pos.uniqueId,
      pos && pos.deviceName
    ].map(cleanKey).filter(Boolean);
  }

  function mergeVehicleSources(configVehicles, firestoreVehicles) {
    const out = Object.assign({}, configVehicles || {});
    Object.entries(firestoreVehicles || {}).forEach(([id, vehicle]) => {
      out[id] = Object.assign({}, out[id] || {}, vehicle || {});
    });
    return out;
  }

  function findVehicleMatch(pos, vehicles) {
    const pKeys = positionKeys(pos);
    let match = null;
    Object.entries(vehicles || {}).forEach(([id, vehicle]) => {
      if (match) return;
      const key = vehicleKeys(id, vehicle).find((candidate) => pKeys.includes(candidate));
      if (key) match = { id, vehicle, key };
    });
    return match;
  }

  function fallbackVehicleId(pos) {
    if (pos && pos.deviceId) return "TRACKER_" + idSafe(pos.deviceId);
    if (pos && pos.uniqueId) return "TRACKER_" + idSafe(String(pos.uniqueId).slice(-10));
    if (pos && pos.plate) return idSafe(pos.plate);
    if (pos && pos.trackerId) return "TRACKER_" + idSafe(pos.trackerId);
    return "";
  }

  function providerMatchesVehicle(provider, vehicle) {
    if (!provider || !vehicle) return true;
    const wanted = cleanKey(vehicle.trackerProviderId);
    if (!wanted) return true;
    return wanted === cleanKey(provider.id || provider.providerId) || wanted === cleanKey(provider.providerType);
  }

  function positionToVehicleUpdate(pos, vehicle, match, provider, now) {
    return {
      placa: vehicle.placa || (match ? match.id : pos.deviceName || pos.plate || match && match.id || fallbackVehicleId(pos)),
      apelido: vehicle.apelido || pos.deviceName || "",
      tipo: vehicle.tipo || "",
      location: { lat: pos.lat, lng: pos.lng },
      trackerId: pos.trackerId,
      trackerProviderId: provider && (provider.id || provider.providerId) || pos.providerId || "",
      trackerProviderType: provider && provider.providerType || pos.providerType || "",
      trackerDeviceId: pos.deviceId || "",
      trackerExternalId: pos.trackerId || pos.deviceId || "",
      trackerUniqueId: pos.uniqueId || "",
      trackerDeviceName: pos.deviceName || "",
      trackerMatched: Boolean(match),
      trackerUnmapped: !match,
      trackerMatchKey: match && match.key || "",
      trackerSource: pos.source,
      trackerLastSource: pos.source,
      trackerStatus: pos.rawStatus,
      trackerAddress: pos.address || "",
      speed: pos.speed,
      ignition: pos.ignition,
      lastTrackerAt: pos.capturedAt,
      trackerLastUpdateAt: pos.capturedAt,
      lastTrackerSyncAt: now,
      updatedAt: now
    };
  }

  async function syncTrackerToFirestore(config, db, vehicles) {
    const positions = await fetchTrackerPositions(config);
    if (!positions.length) return [];
    const knownVehicles = mergeVehicleSources(config && config.vehicles, vehicles);
    const batch = db.batch();
    const now = new Date().toISOString();
    positions.forEach((pos) => {
      const match = findVehicleMatch(pos, knownVehicles);
      const vehicleId = match && match.id || fallbackVehicleId(pos);
      if (!vehicleId) return;
      const vehicle = match && match.vehicle || knownVehicles[vehicleId] || {};
      pos.vehicleId = vehicleId;
      pos.trackerMatched = Boolean(match);
      pos.trackerMatchKey = match && match.key || "";
      const ref = db.collection("vehicles").doc(vehicleId);
      batch.set(ref, positionToVehicleUpdate(pos, vehicle, match, config || {}, now), { merge: true });
    });
    await batch.commit();
    return positions;
  }

  async function syncProviderToFirestore(provider, db, vehicles) {
    provider = normalizeProvider(provider);
    if (provider.active === false || ["manual", "mobile_gps"].includes(provider.providerType)) return [];
    const positions = await fetchTrackerPositions(provider);
    if (!positions.length) return [];
    const knownVehicles = mergeVehicleSources(provider.vehicles, vehicles);
    const batch = db.batch();
    const now = new Date().toISOString();
    let matchedCount = 0;
    positions.forEach((pos) => {
      const candidates = Object.fromEntries(Object.entries(knownVehicles || {}).filter(([, vehicle]) => providerMatchesVehicle(provider, vehicle)));
      const match = findVehicleMatch(pos, Object.keys(candidates).length ? candidates : knownVehicles);
      const vehicleId = match && match.id || fallbackVehicleId(pos);
      if (!vehicleId) return;
      const vehicle = match && match.vehicle || knownVehicles[vehicleId] || {};
      pos.vehicleId = vehicleId;
      pos.trackerMatched = Boolean(match);
      pos.trackerMatchKey = match && match.key || "";
      if (match) matchedCount += 1;
      batch.set(db.collection("vehicles").doc(vehicleId), positionToVehicleUpdate(pos, vehicle, match, provider, now), { merge: true });
    });
    batch.set(db.collection("trackerProviders").doc(provider.id || provider.providerId), {
      lastSyncAt: now,
      lastLocatedCount: positions.length,
      lastMatchedCount: matchedCount,
      lastError: ""
    }, { merge: true });
    await batch.commit();
    return positions;
  }

  async function syncAllTrackersToFirestore(options) {
    const db = options && options.db;
    const vehicles = options && options.vehicles || {};
    const legacyTracker = options && options.legacyTracker || {};
    const providers = (options && options.providers || []).filter(Boolean).map(normalizeProvider)
      .filter((p) => p.active !== false)
      .sort((a, b) => Number(a.priority || 50) - Number(b.priority || 50));
    const activeProviders = providers.length ? providers : (legacyTracker && legacyTracker.endpoint ? [Object.assign({ id: "rafa", providerType: "rafa", priority: 1 }, legacyTracker)] : []);
    const all = [];
    for (const provider of activeProviders) {
      try {
        const rows = await syncProviderToFirestore(provider, db, vehicles);
        all.push(...rows);
      } catch (err) {
        console.warn("Falha no rastreador", provider.name || provider.id || provider.providerType, err);
        if (db && (provider.id || provider.providerId)) {
          await db.collection("trackerProviders").doc(provider.id || provider.providerId).set({
            lastSyncAt: new Date().toISOString(),
            lastError: err && err.message || String(err)
          }, { merge: true }).catch(() => {});
        }
      }
    }
    return all;
  }

  function getNormalizedFleetPositions(vehicles, mobileGps) {
    const rows = [];
    Object.values(vehicles || {}).forEach((vehicle) => {
      const p = window.JM.utils.pointFrom(vehicle && vehicle.location);
      let hasTrackerPoint = false;
      if (p) {
        hasTrackerPoint = !String(vehicle.gpsSource || vehicle.trackerLastSource || vehicle.trackerSource || "").includes("driver_phone");
        rows.push({
          vehicleId: vehicle.id || vehicle.placa,
          driverId: vehicle.activeDriverId || "",
          providerId: vehicle.trackerProviderId || "",
          providerType: vehicle.trackerProviderType || "",
          source: vehicle.trackerLastSource || vehicle.trackerSource || "tracker",
          lat: p.lat,
          lng: p.lng,
          speed: vehicle.speed || 0,
          heading: vehicle.heading || 0,
          ignition: vehicle.ignition,
          address: vehicle.trackerAddress || "",
          accuracy: vehicle.accuracy || "",
          updatedAt: vehicle.trackerLastUpdateAt || vehicle.lastTrackerAt || vehicle.updatedAt || "",
          raw: vehicle
        });
      }
      const phone = mobileGps && mobileGps[vehicle.id || vehicle.placa];
      const pp = window.JM.utils.pointFrom(phone && (phone.point || phone.location || phone));
      if (pp && !hasTrackerPoint) {
        rows.push({
          vehicleId: vehicle.id || vehicle.placa,
          driverId: phone.driverId || vehicle.activeDriverId || "",
          providerId: "mobile_gps",
          providerType: "mobile_gps",
          source: "mobile_phone",
          lat: pp.lat,
          lng: pp.lng,
          accuracy: phone.accuracy || phone.point && phone.point.accuracy || "",
          speed: phone.speed || phone.point && phone.point.speed || 0,
          heading: phone.heading || phone.point && phone.point.heading || 0,
          updatedAt: phone.updatedAt || phone.capturedAt || "",
          raw: phone
        });
      }
    });
    return rows;
  }

  window.JM = window.JM || {};
  window.JM.tracker = { fetchTrackerPositions, syncTrackerToFirestore, syncAllTrackersToFirestore, syncProviderToFirestore, normalizePosition, getNormalizedFleetPositions, joinUrl };
}());
