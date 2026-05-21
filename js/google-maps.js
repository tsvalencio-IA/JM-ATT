(function () {
  "use strict";

  const { coords, pointFrom, haversineKm, roundPoint, normalizeUrl } = window.JM.utils;
  const DEFAULT_SPEED_KMH = 48;
  const DEFAULT_OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
  const routeCache = new Map();

  function toLatLng(value) {
    const p = pointFrom(value);
    return p ? { lat: Number(p.lat), lng: Number(p.lng) } : null;
  }

  function cleanText(value) {
    return String(value || "").trim();
  }

  function decodeSafe(value) {
    try { return decodeURIComponent(String(value || "")); } catch (_) { return String(value || ""); }
  }

  function uniquePoints(points) {
    const seen = new Set();
    return (points || []).filter((p) => {
      const point = toLatLng(p);
      if (!point) return false;
      const key = point.lat.toFixed(6) + "," + point.lng.toFixed(6);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(toLatLng);
  }

  function extractCoordinatePairs(text) {
    const raw = decodeSafe(text).replace(/%2C/gi, ",").replace(/\u2212/g, "-");
    const points = [];
    const patterns = [
      /@(-?\d{1,2}(?:[.,]\d+)?),\s*(-?\d{1,3}(?:[.,]\d+)?)/ig,
      /(?:q|query|ll|center|destination|daddr|saddr|origin)=(-?\d{1,2}(?:[.,]\d+)?),\s*(-?\d{1,3}(?:[.,]\d+)?)/ig,
      /(?:lat|latitude)=(-?\d{1,2}(?:[.,]\d+)?).*?(?:lng|lon|longitude)=(-?\d{1,3}(?:[.,]\d+)?)/ig,
      /!3d(-?\d{1,2}(?:[.,]\d+)?)!4d(-?\d{1,3}(?:[.,]\d+)?)/ig,
      /\/dir\/(-?\d{1,2}(?:[.,]\d+)?),\s*(-?\d{1,3}(?:[.,]\d+)?)(?:\/|$|\?)/ig,
      /\/(-?\d{1,2}(?:[.,]\d+)?),\s*(-?\d{1,3}(?:[.,]\d+)?)(?:\/|$|\?)/ig,
      /(-?\d{1,2}(?:[.,]\d+)?)\s*[,;]\s*(-?\d{1,3}(?:[.,]\d+)?)/ig
    ];
    patterns.forEach((pattern) => {
      let match;
      while ((match = pattern.exec(raw)) !== null) {
        const point = coords(match[1], match[2]);
        if (point) points.push(point);
      }
    });
    return uniquePoints(points);
  }

  function extractCoordinatePair(text) {
    return extractCoordinatePairs(text)[0] || null;
  }

  function providerFromUrl(url) {
    const raw = String(url || "").toLowerCase();
    if (raw.includes("waze.com")) return "waze";
    if (raw.includes("google") || raw.includes("goo.gl") || raw.includes("maps.app.goo.gl")) return "google_maps";
    if (raw.includes("openstreetmap")) return "openstreetmap";
    return raw ? "external" : "manual";
  }

  function parseLocationInput(value, fallbackLabel) {
    const input = cleanText(value);
    if (!input) return null;
    const point = extractCoordinatePair(input);
    const isUrl = /^https?:\/\//i.test(input) || /maps\.app\.goo\.gl|google\.[^/]+\/maps|waze\.com|openstreetmap\.org/i.test(input);
    return {
      label: point ? (fallbackLabel || input) : input,
      coords: point,
      source: point ? (isUrl ? "shared_map_link" : "manual_coordinates") : (isUrl ? "shared_link_without_visible_coords" : "manual_text_without_coords"),
      provider: isUrl ? providerFromUrl(input) : "manual",
      raw: input,
      externalUrl: isUrl ? normalizeUrl(input) : "",
      resolvedAt: new Date().toISOString()
    };
  }

  function parseRouteInput(value) {
    const input = cleanText(value);
    const externalUrl = normalizeUrl(input);
    const points = extractCoordinatePairs(input);
    return {
      raw: input,
      externalUrl,
      provider: providerFromUrl(input),
      points,
      source: points.length >= 2 ? "shared_route_with_visible_coords" : points.length === 1 ? "shared_point_with_visible_coords" : externalUrl ? "shared_route_without_visible_coords" : "manual_text_without_coords",
      resolvedAt: new Date().toISOString()
    };
  }

  function isConfigured() {
    return true;
  }

  async function initAutocomplete(inputId, onSelect) {
    const input = document.getElementById(inputId);
    if (!input) return null;
    input.setAttribute("autocomplete", "off");
    input.addEventListener("change", () => {
      const parsed = parseLocationInput(input.value);
      if (parsed && parsed.coords && typeof onSelect === "function") onSelect(parsed);
    });
    return null;
  }

  async function geocode(text) {
    const parsed = parseLocationInput(text);
    if (!parsed || !parsed.coords) {
      throw new Error("Cole um link do mapa que mostre latitude/longitude ou informe no formato -20.851076,-49.398946. Links curtos do Google nem sempre trazem coordenadas visíveis para leitura automática.");
    }
    return parsed;
  }

  function estimateRoute(a, b, label) {
    const p1 = toLatLng(a);
    const p2 = toLatLng(b);
    if (!p1 || !p2) return null;
    const km = haversineKm(p1, p2);
    const roadFactor = 1.28;
    const roadKm = km * roadFactor;
    const minutes = Math.max(1, Math.round((roadKm / DEFAULT_SPEED_KMH) * 60));
    return {
      source: "fallback_haversine",
      label: label || "estimativa gratuita",
      distanceMeters: Math.round(roadKm * 1000),
      distanceText: roadKm.toFixed(1).replace(".", ",") + " km estimados",
      durationSeconds: minutes * 60,
      durationText: minutes + " min estimados",
      durationTrafficText: minutes + " min estimados",
      start: p1,
      end: p2,
      geometry: { type: "LineString", coordinates: [[p1.lng, p1.lat], [p2.lng, p2.lat]] },
      isPrecise: false
    };
  }

  function osrmBase(settings) {
    return String(settings && (settings.osrmUrl || settings.osrmEndpoint) || DEFAULT_OSRM_URL).replace(/\/$/, "");
  }

  function routeKey(points, settings) {
    const clean = uniquePoints(points).map((p) => roundPoint(p, 5)).filter(Boolean);
    return osrmBase(settings) + "|" + clean.map((p) => p.lng + "," + p.lat).join(";");
  }

  function routeText(meters) {
    const km = Number(meters || 0) / 1000;
    return km >= 10 ? km.toFixed(0).replace(".", ",") + " km" : km.toFixed(1).replace(".", ",") + " km";
  }

  function durationText(seconds) {
    const min = Math.max(1, Math.round(Number(seconds || 0) / 60));
    if (min < 60) return min + " min";
    const h = Math.floor(min / 60);
    const rest = min % 60;
    return rest ? h + "h " + rest + "min" : h + "h";
  }

  async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms || 12000);
    try {
      return await fetch(url, { signal: controller.signal, cache: "no-store" });
    } finally {
      clearTimeout(timer);
    }
  }

  async function osrmRoute(points, settings) {
    const clean = uniquePoints(points);
    if (clean.length < 2) return null;
    const key = routeKey(clean, settings);
    if (routeCache.has(key)) return routeCache.get(key);
    const coordinates = clean.map((p) => p.lng + "," + p.lat).join(";");
    const url = osrmBase(settings) + "/" + coordinates + "?overview=full&geometries=geojson&steps=false&alternatives=false";
    const promise = fetchWithTimeout(url, Number(settings && settings.routeTimeoutMs) || 12000)
      .then(async (response) => {
        if (!response.ok) throw new Error("OSRM indisponível: HTTP " + response.status);
        const data = await response.json();
        const route = data && data.routes && data.routes[0];
        if (!route || !route.geometry || !Array.isArray(route.geometry.coordinates)) throw new Error("OSRM não retornou geometria de rota.");
        return {
          source: "osrm_openstreetmap",
          label: "rota por ruas/rodovias OSM",
          distanceMeters: Math.round(route.distance || 0),
          distanceText: routeText(route.distance),
          durationSeconds: Math.round(route.duration || 0),
          durationText: durationText(route.duration),
          durationTrafficText: durationText(route.duration),
          geometry: route.geometry,
          start: clean[0],
          end: clean[clean.length - 1],
          isPrecise: true,
          calculatedAt: new Date().toISOString()
        };
      });
    routeCache.set(key, promise);
    return promise;
  }

  async function routeThroughPoints(points, settings) {
    const clean = uniquePoints(points);
    if (clean.length < 2) return null;
    try {
      return await osrmRoute(clean, settings || {});
    } catch (err) {
      console.warn("Falha OSRM, usando fallback reto/estimado:", err);
      let distanceMeters = 0;
      const lineCoords = clean.map((p) => [p.lng, p.lat]);
      for (let i = 1; i < clean.length; i += 1) distanceMeters += (estimateRoute(clean[i - 1], clean[i]) || {}).distanceMeters || 0;
      const seconds = Math.max(60, Math.round((distanceMeters / 1000 / DEFAULT_SPEED_KMH) * 3600));
      return {
        source: "fallback_haversine",
        label: "fallback por linha estimada",
        distanceMeters,
        distanceText: routeText(distanceMeters) + " estimados",
        durationSeconds: seconds,
        durationText: durationText(seconds) + " estimados",
        durationTrafficText: durationText(seconds) + " estimados",
        geometry: { type: "LineString", coordinates: lineCoords },
        start: clean[0],
        end: clean[clean.length - 1],
        isPrecise: false,
        fallbackReason: err && err.message || "OSRM indisponível",
        calculatedAt: new Date().toISOString()
      };
    }
  }

  function routeUrl(points) {
    const clean = (points || []).map(toLatLng).filter(Boolean);
    if (clean.length < 2) return "";
    const params = new URLSearchParams({ api: "1", travelmode: "driving" });
    params.set("origin", clean[0].lat + "," + clean[0].lng);
    params.set("destination", clean[clean.length - 1].lat + "," + clean[clean.length - 1].lng);
    if (clean.length > 2) params.set("waypoints", clean.slice(1, -1).map((p) => p.lat + "," + p.lng).join("|"));
    return "https://www.google.com/maps/dir/?" + params.toString();
  }

  function statusPenalty(vehicle) {
    const status = String(vehicle && vehicle.status || "").toLowerCase();
    if (status.includes("manut") || status.includes("indispon")) return 100000;
    if (status.includes("atendimento") || status.includes("ocup")) return 1000;
    return 0;
  }

  async function rankVehicles(vehicles, origin, destination, settings) {
    const target = toLatLng(origin);
    if (!target) throw new Error("Origem sem coordenadas para calcular a rota.");
    const dest = toLatLng(destination);
    const located = Object.values(vehicles || {}).filter((v) => toLatLng(v.location));
    const serviceRouteShared = dest ? await routeThroughPoints([target, dest], settings || {}) : null;
    const rankings = await Promise.all(located.map(async (vehicle) => {
      const vPoint = toLatLng(vehicle.location);
      const toOrigin = await routeThroughPoints([vPoint, target], settings || {});
      const fullRoute = await routeThroughPoints([vPoint, target, dest].filter(Boolean), settings || {});
      const score = (toOrigin ? toOrigin.durationSeconds : 999999) + statusPenalty(vehicle);
      return {
        vehicle,
        toOrigin,
        serviceRoute: serviceRouteShared,
        fullRoute,
        kmToOrigin: toOrigin ? toOrigin.distanceMeters / 1000 : 0,
        minutesToOrigin: toOrigin ? Math.round(toOrigin.durationSeconds / 60) : 0,
        score,
        routeUrl: routeUrl([vPoint, target, dest].filter(Boolean))
      };
    }));
    return rankings.sort((a, b) => a.score - b.score);
  }

  window.JM = window.JM || {};
  window.JM.freeRouter = {
    parseLocationInput,
    parseRouteInput,
    extractCoordinatePair,
    extractCoordinatePairs,
    isConfigured,
    initAutocomplete,
    geocode,
    estimateRoute,
    routeThroughPoints,
    osrmRoute,
    rankVehicles,
    routeUrl,
    normalizeExternalRouteUrl: normalizeUrl
  };
  // Compatibilidade com a versão anterior: o app ainda chama JM.googleMaps,
  // mas esta implementação não carrega API paga. Rota interna: Leaflet + OSM/OSRM.
  window.JM.googleMaps = window.JM.freeRouter;
}());
