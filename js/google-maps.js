(function () {
  "use strict";

  const { coords, pointFrom, haversineKm } = window.JM.utils;
  const DEFAULT_SPEED_KMH = 48;

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

  function extractCoordinatePair(text) {
    const raw = decodeSafe(text).replace(/%2C/gi, ",").replace(/\u2212/g, "-");
    const patterns = [
      /@(-?\d{1,2}(?:[.,]\d+)?),\s*(-?\d{1,3}(?:[.,]\d+)?)/i,
      /(?:q|query|ll|center|destination|daddr|saddr)=(-?\d{1,2}(?:[.,]\d+)?),\s*(-?\d{1,3}(?:[.,]\d+)?)/i,
      /(?:lat|latitude)=(-?\d{1,2}(?:[.,]\d+)?).*?(?:lng|lon|longitude)=(-?\d{1,3}(?:[.,]\d+)?)/i,
      /(-?\d{1,2}(?:[.,]\d+)?)\s*[,;]\s*(-?\d{1,3}(?:[.,]\d+)?)/,
      /(-?\d{1,2}(?:[.,]\d+)?)\s+(-?\d{1,3}(?:[.,]\d+)?)/
    ];
    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (!match) continue;
      const point = coords(match[1], match[2]);
      if (point) return point;
    }
    return null;
  }

  function parseLocationInput(value, fallbackLabel) {
    const input = cleanText(value);
    if (!input) return null;
    const point = extractCoordinatePair(input);
    const isUrl = /^https?:\/\//i.test(input) || /maps\.app\.goo\.gl|google\.[^/]+\/maps|waze\.com/i.test(input);
    return {
      label: point ? (fallbackLabel || input) : input,
      coords: point,
      source: point ? (isUrl ? "shared_map_link" : "manual_coordinates") : (isUrl ? "shared_link_without_visible_coords" : "manual_text_without_coords"),
      raw: input,
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
      throw new Error("Cole um link do mapa que mostre latitude/longitude ou informe no formato -20.851076,-49.398946. Links curtos do Google nem sempre trazem coordenadas visíveis.");
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
      source: "free_leaflet_haversine",
      label: label || "estimativa gratuita",
      distanceMeters: Math.round(roadKm * 1000),
      distanceText: roadKm.toFixed(1).replace(".", ",") + " km estimados",
      durationSeconds: minutes * 60,
      durationText: minutes + " min estimados",
      durationTrafficText: minutes + " min estimados",
      start: p1,
      end: p2
    };
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

  async function rankVehicles(vehicles, origin, destination) {
    const target = toLatLng(origin);
    if (!target) throw new Error("Origem sem coordenadas para calcular a rota.");
    const located = Object.values(vehicles || {}).filter((v) => toLatLng(v.location));
    const rankings = located.map((vehicle) => {
      const vPoint = toLatLng(vehicle.location);
      const toOrigin = estimateRoute(vPoint, target, "Veículo até origem");
      const serviceRoute = destination ? estimateRoute(target, destination, "Origem até destino") : null;
      const score = (toOrigin ? toOrigin.durationSeconds : 999999) + statusPenalty(vehicle);
      return {
        vehicle,
        toOrigin,
        serviceRoute,
        kmToOrigin: toOrigin ? toOrigin.distanceMeters / 1000 : 0,
        minutesToOrigin: toOrigin ? Math.round(toOrigin.durationSeconds / 60) : 0,
        score,
        routeUrl: routeUrl([vPoint, target, destination].filter(Boolean))
      };
    }).sort((a, b) => a.score - b.score);
    return rankings;
  }

  window.JM = window.JM || {};
  window.JM.freeRouter = {
    parseLocationInput,
    extractCoordinatePair,
    isConfigured,
    initAutocomplete,
    geocode,
    estimateRoute,
    rankVehicles,
    routeUrl
  };
  // Compatibilidade com a versão v11: o app ainda chama JM.googleMaps,
  // mas nesta versão não carrega API paga. Tudo é gratuito: Leaflet + OSM + coordenadas/link compartilhado.
  window.JM.googleMaps = window.JM.freeRouter;
}());
