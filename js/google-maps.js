(function () {
  "use strict";

  const { coords, pointFrom, haversineKm, roundPoint, normalizeUrl } = window.JM.utils;
  const DEFAULT_SPEED_KMH = 48;
  const DEFAULT_OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
  const routeCache = new Map();
  let googleMapsPromise = null;

  function toLatLng(value) {
    const p = pointFrom(value);
    if (!p) return null;
    const lat = Number(p.lat);
    const lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001) return null;
    return { lat, lng };
  }

  function vehiclePoint(vehicle) {
    return toLatLng(vehicle && (
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

  function googleApiKey(settings) {
    return String(settings && (settings.apiKey || settings.mapsKey || settings.googleMapsKey) || "").trim();
  }

  function isGoogleConfigured(settings) {
    return !!googleApiKey(settings);
  }

  function searchSuffix(settings) {
    return cleanText(settings && (settings.searchSuffix || settings.defaultSearchSuffix || settings.city || settings.defaultCity));
  }

  function looksLikeFullAddress(text) {
    const raw = cleanText(text).toLowerCase();
    return /\b(sp|rj|mg|pr|sc|rs|go|mt|ms|ba|pe|ce|brasil|brazil)\b/.test(raw) || raw.includes("sao jose") || raw.includes("são jose");
  }

  function searchQueries(text, settings) {
    const raw = cleanText(text);
    const suffix = searchSuffix(settings);
    if (!raw || !suffix || looksLikeFullAddress(raw)) return [raw];
    return [raw + ", " + suffix, raw];
  }

  function biasBox(settings) {
    const center = toLatLng(settings && settings.center);
    const radius = Number(settings && settings.radiusMeters || 90000);
    if (!center || !Number.isFinite(radius) || radius <= 0) return null;
    const latDelta = radius / 111320;
    const lngDelta = radius / (111320 * Math.max(0.25, Math.cos(center.lat * Math.PI / 180)));
    return {
      west: center.lng - lngDelta,
      south: center.lat - latDelta,
      east: center.lng + lngDelta,
      north: center.lat + latDelta,
      center
    };
  }

  function googlePlaceUrl(value) {
    const point = toLatLng(value);
    if (point) return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(point.lat + "," + point.lng);
    const text = cleanText(value);
    return text ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(text) : "";
  }

  function loadGoogleMaps(settings) {
    const key = googleApiKey(settings);
    if (!key) return Promise.resolve(false);
    if (window.google && window.google.maps) return Promise.resolve(true);
    if (googleMapsPromise) return googleMapsPromise;
    googleMapsPromise = new Promise((resolve, reject) => {
      const callbackName = "__jmGoogleMapsReady";
      window[callbackName] = () => resolve(true);
      const script = document.createElement("script");
      script.async = true;
      script.defer = true;
      script.onerror = () => reject(new Error("Não consegui carregar o Google Maps. Verifique a chave salva no superadmin."));
      script.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) + "&libraries=places,geometry,marker&v=weekly&loading=async&callback=" + callbackName;
      document.head.appendChild(script);
    }).catch((err) => {
      googleMapsPromise = null;
      throw err;
    });
    return googleMapsPromise;
  }

  function geocodeWithGoogle(text, settings) {
    return loadGoogleMaps(settings).then((ok) => new Promise((resolve, reject) => {
      if (!ok || !window.google || !google.maps.Geocoder) return reject(new Error("Google Maps não está configurado."));
      const geocoder = new google.maps.Geocoder();
      const box = biasBox(settings);
      const request = { address: text, region: settings && settings.region || "BR" };
      if (box && google.maps.LatLngBounds) {
        request.bounds = new google.maps.LatLngBounds(
          new google.maps.LatLng(box.south, box.west),
          new google.maps.LatLng(box.north, box.east)
        );
      }
      geocoder.geocode(request, (results, status) => {
        if (status === "OK" && results && results[0] && results[0].geometry && results[0].geometry.location) {
          const loc = results[0].geometry.location;
          return resolve({
            label: results[0].formatted_address || text,
            coords: { lat: loc.lat(), lng: loc.lng() },
            source: "google_geocoding",
            provider: "google_maps",
            raw: text,
            externalUrl: googlePlaceUrl(results[0].formatted_address || text),
            placeId: results[0].place_id || "",
            resolvedAt: new Date().toISOString()
          });
        }
        reject(new Error("O Google Maps não localizou este endereço. Confira bairro, cidade e número."));
      });
    }));
  }

  function chooseBestNominatim(rows, settings) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (!list.length) return null;
    const box = biasBox(settings);
    return list.map((row) => {
      const point = coords(row.lat, row.lon);
      let score = Number(row.importance || 0);
      if (row.type === "house" || row.addresstype === "building") score += 0.35;
      if (row.class === "highway" || row.type === "street") score += 0.12;
      if (box && point) {
        const km = haversineKm(point, box.center);
        score += Math.max(0, 0.35 - (km / 240));
      }
      return { row, score };
    }).sort((a, b) => b.score - a.score)[0].row;
  }

  async function geocodeWithNominatim(text, settings) {
    const queries = searchQueries(text, settings);
    const box = biasBox(settings);
    let rows = [];
    let response = null;
    for (const query of queries) {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("q", query);
    url.searchParams.set("countrycodes", String(settings && settings.country || "br").toLowerCase());
    if (box) url.searchParams.set("viewbox", [box.west, box.north, box.east, box.south].join(","));
    response = await fetch(url.toString(), { headers: { "Accept": "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error("Busca gratuita de endereço indisponível agora. Cole um link do Maps ou coordenadas.");
    rows = await response.json();
    if (rows && rows.length) break;
    }
    const hit = chooseBestNominatim(rows, settings);
    if (!hit) throw new Error("Não encontrei esse endereço na busca gratuita. Digite cidade/UF ou cole o link do Google Maps.");
    const point = coords(hit.lat, hit.lon);
    if (!point) throw new Error("O endereço foi encontrado, mas veio sem coordenadas utilizáveis.");
    return {
      label: hit.display_name || text,
      coords: point,
      source: "nominatim_openstreetmap",
      provider: "openstreetmap",
      raw: text,
      externalUrl: googlePlaceUrl(hit.display_name || text),
      resolvedAt: new Date().toISOString()
    };
  }

  async function initAutocomplete(inputId, onSelect, settings) {
    const input = document.getElementById(inputId);
    if (!input) return null;
    input.setAttribute("autocomplete", "off");
    if (isGoogleConfigured(settings || {})) {
      try {
        await loadGoogleMaps(settings || {});
        if (window.google && google.maps.places) {
          const country = String(settings && (settings.country || settings.region) || "BR").toLowerCase().slice(0, 2);
          const box = biasBox(settings || {});
          const options = {
            componentRestrictions: { country },
            fields: ["formatted_address", "geometry", "name", "place_id"],
            strictBounds: false
          };
          if (box && google.maps.LatLngBounds) {
            options.bounds = new google.maps.LatLngBounds(
              new google.maps.LatLng(box.south, box.west),
              new google.maps.LatLng(box.north, box.east)
            );
          }
          const autocomplete = new google.maps.places.Autocomplete(input, options);
          autocomplete.addListener("place_changed", () => {
            const place = autocomplete.getPlace();
            if (place && place.geometry && place.geometry.location && typeof onSelect === "function") {
              onSelect({
                label: place.formatted_address || place.name || input.value,
                coords: { lat: place.geometry.location.lat(), lng: place.geometry.location.lng() },
                source: "google_places_autocomplete",
                provider: "google_maps",
                raw: input.value,
                externalUrl: googlePlaceUrl(place.formatted_address || input.value),
                placeId: place.place_id || "",
                resolvedAt: new Date().toISOString()
              });
            }
          });
        }
      } catch (err) {
        console.warn("Autocomplete Google indisponível, mantendo busca manual gratuita:", err);
      }
    }
    input.addEventListener("change", () => {
      const parsed = parseLocationInput(input.value);
      if (parsed && parsed.coords && typeof onSelect === "function") onSelect(parsed);
    });
    return null;
  }

  async function geocode(text, settings) {
    const parsed = parseLocationInput(text);
    if (parsed && parsed.coords) return parsed;
    if (!parsed || !parsed.raw) throw new Error("Informe endereço, link do mapa ou coordenadas.");
    if (isGoogleConfigured(settings || {})) {
      try { return await geocodeWithGoogle(parsed.raw, settings || {}); } catch (err) { console.warn(err); }
    }
    return geocodeWithNominatim(parsed.raw, settings || {});
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
    const located = Object.values(vehicles || {}).filter((v) => vehiclePoint(v));
    const serviceRouteShared = dest ? await routeThroughPoints([target, dest], settings || {}) : null;
    const rankings = await Promise.all(located.map(async (vehicle) => {
      const vPoint = vehiclePoint(vehicle);
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
    isGoogleConfigured,
    loadGoogleMaps,
    initAutocomplete,
    geocode,
    geocodeWithGoogle,
    geocodeWithNominatim,
    googlePlaceUrl,
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
