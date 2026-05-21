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

  function normalizePosition(raw, deviceMap) {
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
      source: "tracker",
      capturedAt: raw.fixTime || raw.deviceTime || raw.serverTime || raw.timestamp || raw.time || raw.dataHora || new Date().toISOString()
    };
  }

  async function fetchTrackerPositions(config) {
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
    return flattenTrackerPayload(positionsPayload).map((p) => normalizePosition(p, deviceMap)).filter(Boolean);
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
      batch.set(ref, {
        placa: vehicle.placa || (match ? vehicleId : pos.deviceName || pos.plate || vehicleId),
        apelido: vehicle.apelido || pos.deviceName || "",
        tipo: vehicle.tipo || "",
        location: { lat: pos.lat, lng: pos.lng },
        trackerId: pos.trackerId,
        trackerDeviceId: pos.deviceId || "",
        trackerUniqueId: pos.uniqueId || "",
        trackerDeviceName: pos.deviceName || "",
        trackerMatched: Boolean(match),
        trackerUnmapped: !match,
        trackerMatchKey: match && match.key || "",
        trackerSource: pos.source,
        trackerStatus: pos.rawStatus,
        trackerAddress: pos.address || "",
        speed: pos.speed,
        ignition: pos.ignition,
        lastTrackerAt: pos.capturedAt,
        lastTrackerSyncAt: now,
        updatedAt: now
      }, { merge: true });
    });
    await batch.commit();
    return positions;
  }

  window.JM = window.JM || {};
  window.JM.tracker = { fetchTrackerPositions, syncTrackerToFirestore, normalizePosition, joinUrl };
}());
