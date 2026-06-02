(function () {
  "use strict";

  const { esc, callRoutePoints, routeKm, geoJsonToLatLngs, pointFrom } = window.JM.utils;

  function loadLeaflet() {
    return new Promise((resolve, reject) => {
      if (window.L) return resolve(window.L);
      if (!document.getElementById("leaflet-css")) {
        const css = document.createElement("link");
        css.id = "leaflet-css";
        css.rel = "stylesheet";
        css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.appendChild(css);
      }
      const existing = document.getElementById("leaflet-js");
      if (existing) {
        existing.addEventListener("load", () => resolve(window.L));
        existing.addEventListener("error", reject);
        return;
      }
      const js = document.createElement("script");
      js.id = "leaflet-js";
      js.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      js.onload = () => resolve(window.L);
      js.onerror = () => reject(new Error("Não foi possível carregar Leaflet."));
      document.head.appendChild(js);
    });
  }

  function fallbackSvg(container, vehicles, calls) {
    const rows = Object.values(vehicles || {}).map((v, i) => {
      const x = 90 + i * 170;
      const y = 120 + (i % 2) * 120;
      return `<g><circle cx="${x}" cy="${y}" r="18" fill="#2dd4bf"/><text x="${x + 28}" y="${y + 5}" fill="#edf7f3" font-size="14" font-weight="700">${esc(v.placa || v.id)}</text></g>`;
    }).join("");
    const callRows = Object.values(calls || {}).slice(0, 6).map((c, i) => `<text x="32" y="${330 + i * 24}" fill="#94a3b8" font-size="13">${esc(c.protocolo || c.cliente || "Chamado")}: ${esc(c.status || "")}</text>`).join("");
    container.innerHTML = `<svg class="fallback-map" viewBox="0 0 820 520" preserveAspectRatio="none" role="img" aria-label="Mapa operacional em fallback">
      <rect width="820" height="520" fill="#07110f"/>
      <path d="M80 380 C240 120 380 420 680 140" fill="none" stroke="#22c55e" stroke-width="5" stroke-linecap="round"/>
      ${rows}
      ${callRows}
    </svg>`;
  }

  const liveMaps = {};
  const tileLayers = {};
  const MAP_TILE_PROVIDERS = {
    google_road: {
      name: "Google Road",
      url: "https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
      options: { subdomains: ["0", "1", "2", "3"], maxZoom: 20, attribution: "&copy; Google" }
    },
    google_hybrid: {
      name: "Google Híbrido",
      url: "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
      options: { subdomains: ["0", "1", "2", "3"], maxZoom: 20, attribution: "&copy; Google" }
    },
    osm_road: {
      name: "OpenStreetMap",
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: { maxZoom: 19, attribution: "&copy; OpenStreetMap" }
    }
  };

  function resetMap(containerId, container) {
    if (liveMaps[containerId]) {
      try { liveMaps[containerId].remove(); } catch (_) {}
      delete liveMaps[containerId];
      delete tileLayers[containerId];
    }
    if (container && container._leaflet_id) {
      try { container._leaflet_id = null; } catch (_) {}
    }
  }

  function selectedTileProvider() {
    const settings = window.JM_MAP_SETTINGS || {};
    const key = settings.provider || settings.tileProvider || settings.mapProvider || "google_road";
    return MAP_TILE_PROVIDERS[key] || MAP_TILE_PROVIDERS.google_road;
  }

  function addBaseLayer(L, map, containerId) {
    const provider = selectedTileProvider();
    const layer = L.tileLayer(provider.url, Object.assign({}, provider.options || {}));
    tileLayers[containerId] = layer;
    layer.addTo(map);
    return layer;
  }

  function fitVisibleBounds(map, bounds, options) {
    const clean = (bounds || []).filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])));
    if (!clean.length) return;
    if (clean.length === 1) {
      map.setView(clean[0], options && options.singleZoom || 16);
      return;
    }
    map.fitBounds(clean, {
      padding: options && options.padding || [56, 56],
      maxZoom: options && options.maxZoom || 16
    });
  }

  function routeTitle(call, route, fallbackKm) {
    const prefix = esc(call.protocolo || call.cliente || "Chamado");
    if (route && route.isPrecise) return `${prefix}<br>Rota por ruas/rodovias: ${esc(route.distanceText || "")}`;
    if (route) return `${prefix}<br>Rota estimada/fallback: ${esc(route.distanceText || fallbackKm.toFixed(1) + " km")}`;
    return `${prefix}<br>${fallbackKm.toFixed(1)} km estimados`;
  }

  async function addRouteLayer(L, map, call, pts, bounds) {
    const router = window.JM && (window.JM.freeRouter || window.JM.googleMaps);
    const cleanPoints = pts.map((p) => p.point).filter(Boolean);
    let route = null;
    const hasLivePhoneGps = pts.some((p) => p && p.kind === "driver_phone");
    const storedGeometry = hasLivePhoneGps ? null : call && (call.routeGeometry || call.routeMetrics && call.routeMetrics.fullRoute && call.routeMetrics.fullRoute.geometry);
    const storedLatLngs = storedGeometry ? geoJsonToLatLngs(storedGeometry) : [];
    if (storedLatLngs.length >= 2) {
      storedLatLngs.forEach((p) => bounds.push(p));
      L.polyline(storedLatLngs, { color: "#22c55e", weight: 6, opacity: 0.86 }).addTo(map)
        .bindPopup(routeTitle(call, { isPrecise: true, distanceText: call.routeDistanceText || "" }, routeKm(pts)));
      return { source: "stored_route", isPrecise: true };
    }
    if (router && typeof router.routeThroughPoints === "function" && cleanPoints.length >= 2) {
      route = await router.routeThroughPoints(cleanPoints, window.JM_MAP_SETTINGS || {});
    }
    const routeLatLngs = route && route.geometry ? geoJsonToLatLngs(route.geometry) : [];
    const fallbackKm = routeKm(pts);
    if (routeLatLngs.length >= 2) {
      routeLatLngs.forEach((p) => bounds.push(p));
      L.polyline(routeLatLngs, {
        color: route.isPrecise ? "#22c55e" : "#f59e0b",
        weight: route.isPrecise ? 6 : 4,
        opacity: route.isPrecise ? 0.88 : 0.72,
        dashArray: route.isPrecise ? null : "8,8"
      }).addTo(map).bindPopup(routeTitle(call, route, fallbackKm));
      return route;
    }
    if (pts.length >= 2) {
      const latlngs = pts.map((p) => [p.point.lat, p.point.lng]);
      latlngs.forEach((p) => bounds.push(p));
      L.polyline(latlngs, { color: "#f59e0b", weight: 4, opacity: 0.72, dashArray: "8,8" }).addTo(map)
        .bindPopup(routeTitle(call, null, fallbackKm));
    }
    return route;
  }

  function isFinal(status) {
    return ["Finalizado", "Cancelado"].includes(String(status || ""));
  }

  function operationalStatus(status) {
    const raw = String(status || "").toLowerCase();
    if (raw.includes("final")) return "Finalizado";
    if (raw.includes("cancel")) return "Cancelado";
    if (raw.includes("local")) return "No Local";
    if (raw.includes("transporte") || raw.includes("entreg")) return "Em Transporte";
    if (raw.includes("rota") || raw.includes("atendimento") || raw.includes("caminho")) return "Em Rota";
    if (raw.includes("despach")) return "Despachado";
    return "Aguardando Despacho";
  }

  function matchesFilter(call, options) {
    if (call && call.deletedAt) return false;
    const filter = options && options.filter || "ativos";
    if (filter === "todos") return true;
    if (filter === "ativos") return !window.JM.utils.isFinalStatus(call);
    return window.JM.utils.statusKey(call) === filter || operationalStatus(call && call.status) === filter;
  }

  function vehicleLivePoint(vehicle) {
    return pointFrom(vehicle && (vehicle.location || vehicle.mobileLocation || vehicle.driverPhoneLocation || vehicle.phoneLocation));
  }

  const VEHICLE_ICON_BASE = "assets/vehicle-icons/carsv2-map/";
  const VEHICLE_ICONS = {
    motorcycle: "motorcycle_base.png",
    scooter: "scooter_base.png",
    car: "carroPasseio_base.png",
    utility: "carroUtilitario_base.png",
    truck: "truckBau_base.png",
    truckHorse: "truckCavalo_base.png",
    bus: "bus_base.png",
    van: "vanUtilitario_base.png",
    pickup: "carroUtilitario_base.png",
    tractor: "tractor_base.png",
    bicycle: "bicycle_base.png",
    person: "person_base.png",
    boat: "boat_base.png",
    ship: "ship_base.png",
    airplane: "plane_base.png",
    helicopter: "helicopter_base.png",
    crane: "crane_base.png",
    offroad: "offroad_base.png",
    default: "default_base.png"
  };

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function detectVehicleCategory(vehicle) {
    const raw = normalizeText([
      vehicle && vehicle.tipo,
      vehicle && vehicle.type,
      vehicle && vehicle.category,
      vehicle && vehicle.apelido,
      vehicle && vehicle.modelo,
      vehicle && vehicle.model,
      vehicle && vehicle.placa,
      vehicle && vehicle.id
    ].filter(Boolean).join(" "));
    if (/munck|munk|guincho|guindaste|crane|plataforma/.test(raw)) return "crane";
    if (/moto|motorcycle|motocicleta/.test(raw)) return "motorcycle";
    if (/scooter/.test(raw)) return "scooter";
    if (/cavalo|carreta/.test(raw)) return "truckHorse";
    if (/caminhao|truck|bau|baú/.test(raw)) return "truck";
    if (/onibus|ônibus|bus/.test(raw)) return "bus";
    if (/van|utilitario|utilitário|furgao|furgão/.test(raw)) return "van";
    if (/pickup|pick-up|hilux|s10|ranger|amarok|frontier/.test(raw)) return "pickup";
    if (/trator|tractor/.test(raw)) return "tractor";
    if (/bike|bicycle|bicicleta/.test(raw)) return "bicycle";
    if (/pessoa|person|motorista/.test(raw)) return "person";
    if (/barco|boat/.test(raw)) return "boat";
    if (/navio|ship/.test(raw)) return "ship";
    if (/aviao|avião|plane/.test(raw)) return "airplane";
    if (/helicoptero|helicóptero|helicopter/.test(raw)) return "helicopter";
    if (/offroad|off-road|quadriciclo/.test(raw)) return "offroad";
    if (/util/.test(raw)) return "utility";
    return "car";
  }

  function vehicleIconUrl(category) {
    return VEHICLE_ICON_BASE + (VEHICLE_ICONS[category] || VEHICLE_ICONS.default);
  }

  function vehicleCourse(vehicle) {
    const live = vehicle && (vehicle.location || vehicle.mobileLocation || vehicle.driverPhoneLocation || vehicle.phoneLocation) || {};
    const value = live.course || live.heading || live.bearing || vehicle && (vehicle.course || vehicle.heading || vehicle.bearing);
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(((n % 360) + 360) % 360);
  }

  function vehicleStatusTone(vehicle) {
    const gpsSource = String(vehicle && (vehicle.gpsSource || vehicle.trackerStatus || "") || "").toLowerCase();
    const isPhoneGps = gpsSource.includes("driver_phone") || gpsSource.includes("celular");
    const status = String(vehicle && vehicle.status || "").toLowerCase();
    if (status.includes("manut") || status.includes("indispon")) return "blocked";
    if (isPhoneGps) return "phone";
    if (status.includes("atendimento") || status.includes("rota") || status.includes("despach")) return "busy";
    return "online";
  }

  function vehicleSourceLabel(vehicle) {
    const gpsSource = String(vehicle && (vehicle.gpsSource || vehicle.trackerStatus || "") || "");
    if (gpsSource.toLowerCase().includes("driver_phone") || gpsSource.toLowerCase().includes("celular")) return "GPS celular";
    return vehicle && (vehicle.trackerStatus || vehicle.gpsSource) || "GPS/Tracker";
  }

  function vehiclePopupHtml(vehicle, livePoint) {
    const title = esc(vehicle && (vehicle.placa || vehicle.id || "Veículo") || "Veículo");
    const subtitle = esc(vehicle && (vehicle.apelido || vehicle.tipo || "Frota JM") || "Frota JM");
    const status = esc(vehicle && vehicle.status || "Disponível");
    const source = esc(vehicleSourceLabel(vehicle));
    const updated = esc(vehicle && (vehicle.lastPhoneGpsAt || vehicle.lastTrackerAt || vehicle.updatedAt) || "");
    const coords = livePoint ? `${Number(livePoint.lat).toFixed(5)}, ${Number(livePoint.lng).toFixed(5)}` : "sem coordenada";
    const category = esc(detectVehicleCategory(vehicle));
    return `<div class="jm-vehicle-popup">
      <div class="jm-vehicle-popup-head">
        <span class="jm-vehicle-popup-icon"><img src="${esc(vehicleIconUrl(category))}" alt=""></span>
        <div><b>${title}</b><small>${subtitle}</small></div>
      </div>
      <div class="jm-vehicle-popup-grid">
        <span><small>Status</small><b>${status}</b></span>
        <span><small>Origem GPS</small><b>${source}</b></span>
        <span><small>Coordenadas</small><b>${esc(coords)}</b></span>
        <span><small>Atualização</small><b>${updated || "-"}</b></span>
      </div>
    </div>`;
  }

  function vehicleIcon(L, vehicle, selected) {
    const category = detectVehicleCategory(vehicle);
    const tone = vehicleStatusTone(vehicle);
    const label = esc(vehicle && (vehicle.placa || vehicle.id || "JM") || "JM");
    const title = esc(vehicle && (vehicle.apelido || vehicle.tipo || "Frota") || "Frota");
    const course = vehicleCourse(vehicle);
    const size = selected ? 46 : 38;
    const classes = [
      "jm-vehicle-image-marker",
      "tone-" + tone,
      selected ? "is-selected" : "",
      size < 60 ? "marker-compact" : "marker-detailed"
    ].filter(Boolean).join(" ");
    return L.divIcon({
      className: "jm-vehicle-marker-wrap",
      html: `<div class="${classes}" title="${title}" style="--marker-size:${size}px">
        <span class="jm-vehicle-image-core" style="transform: rotate(${course}deg)">
          <img class="jm-vehicle-image-img" src="${esc(vehicleIconUrl(category))}" alt="" loading="eager" decoding="async">
        </span>
        <span class="jm-vehicle-status-dot"></span>
        <strong>${label}</strong>
      </div>`,
      iconSize: [size + 30, size + 24],
      iconAnchor: [Math.round((size + 30) / 2), Math.round(size / 2)],
      popupAnchor: [0, -Math.round(size * 0.62)]
    });
  }

  function enrichVehiclesWithPhoneGps(vehicles, calls) {
    const out = Object.assign({}, vehicles || {});
    Object.values(calls || {}).forEach((call) => {
      if (!call || call.deletedAt || !call.vehicleId) return;
      const phonePoint = pointFrom(call.driverPhoneLocation || call.mobileLocation || call.driverLocation);
      if (!phonePoint) return;
      const current = out[call.vehicleId] || { id: call.vehicleId, placa: call.vehiclePlate || call.vehicleId };
      const hasTrackerPoint = pointFrom(current.location) && String(current.gpsSource || current.locationSource || current.trackerStatus || "").toLowerCase().includes("tracker");
      out[call.vehicleId] = Object.assign({}, current, {
        location: hasTrackerPoint ? current.location : phonePoint,
        mobileLocation: phonePoint,
        driverPhoneLocation: phonePoint,
        gpsSource: hasTrackerPoint ? (current.gpsSource || "tracker") : "driver_phone",
        trackerStatus: hasTrackerPoint ? (current.trackerStatus || "Tracker RAFA") : "GPS celular motorista",
        lastTrackerAt: current.lastTrackerAt || call.phoneLocationUpdatedAt || phonePoint.capturedAt,
        lastPhoneGpsAt: call.phoneLocationUpdatedAt || phonePoint.capturedAt,
        activeCallId: call.id,
        activeDriverId: call.driverId || current.activeDriverId || ""
      });
    });
    return out;
  }

  async function renderFleetMap(containerId, vehicles, calls, options) {
    options = options || {};
    const container = document.getElementById(containerId);
    if (!container) return;
    vehicles = enrichVehiclesWithPhoneGps(vehicles, calls);
    const located = Object.values(vehicles || {}).filter((v) => !v.deletedAt && vehicleLivePoint(v));
    const routedCalls = Object.values(calls || {}).filter((c) => matchesFilter(c, options)).map((call) => {
      const forcedVehicle = options.selectedCallId && call.id === options.selectedCallId && options.selectedVehicleId ? vehicles && vehicles[options.selectedVehicleId] : null;
      const baseVehicle = forcedVehicle || vehicles && vehicles[call.vehicleId];
      const live = vehicleLivePoint(baseVehicle);
      const vehicle = live ? Object.assign({}, baseVehicle, { location: live }) : baseVehicle;
      return { call, vehicle, pts: callRoutePoints(call, vehicle) };
    }).filter((row) => row.pts.length);
    if (!located.length && !routedCalls.length) {
      resetMap(containerId, container);
      container.innerHTML = `<div style="height:100%;display:grid;place-items:center;padding:24px;text-align:center;background:#07110f">
        <div>
          <h3>Mapa aguardando dados reais</h3>
          <p class="muted small">Cadastre rastreadores na frota ou registre um chamado com origem/destino validados para aparecer no mapa.</p>
        </div>
      </div>`;
      return;
    }
    try {
      const L = await loadLeaflet();
      resetMap(containerId, container);
      container.innerHTML = "";
      const map = L.map(containerId, { scrollWheelZoom: false, preferCanvas: true, zoomControl: false });
      liveMaps[containerId] = map;
      L.control.zoom({ position: "bottomright" }).addTo(map);
      addBaseLayer(L, map, containerId);
      const bounds = [];
      const focusBounds = [];
      located.forEach((vehicle) => {
        const livePoint = vehicleLivePoint(vehicle);
        if (!livePoint) return;
        const p = [Number(livePoint.lat), Number(livePoint.lng)];
        bounds.push(p);
        const isSelected = options.selectedVehicleId && vehicle.id === options.selectedVehicleId;
        if (isSelected) focusBounds.push(p);
        const marker = L.marker(p, { icon: vehicleIcon(L, vehicle, isSelected), zIndexOffset: isSelected ? 900 : 0 }).addTo(map)
          .bindPopup(vehiclePopupHtml(vehicle, livePoint), {
            className: "jm-vehicle-leaflet-popup",
            maxWidth: 360,
            autoPanPadding: [24, 24]
          });
        if (isSelected) {
          L.circleMarker(p, { radius: 24, weight: 2, color: "#2dd4bf", fillOpacity: 0.08, opacity: 0.72 }).addTo(map);
          marker.openPopup();
        }
      });
      for (const { call, pts } of routedCalls) {
        const callSelected = options.selectedCallId && call.id === options.selectedCallId;
        pts.forEach((p) => {
          const latlng = [p.point.lat, p.point.lng];
          bounds.push(latlng);
          if (callSelected) focusBounds.push(latlng);
          const kindColor = p.kind === "origin" ? "#22c55e" : p.kind === "destination" ? "#ef4444" : p.kind === "driver_phone" ? "#a78bfa" : p.kind === "vehicle" ? "#2dd4bf" : "#f8b84e";
          L.circleMarker(latlng, { radius: callSelected ? 9 : 6, weight: callSelected ? 4 : 2, color: kindColor, fillOpacity: callSelected ? 0.45 : 0.25 }).addTo(map).bindPopup(`<b>${esc(p.label || "Ponto")}</b><br>${esc(call.protocolo || call.cliente || "Chamado")}`);
        });
        if (pts.length >= 2) await addRouteLayer(L, map, call, pts, bounds);
      }
      fitVisibleBounds(map, focusBounds.length ? focusBounds : bounds, { singleZoom: 16, maxZoom: focusBounds.length ? 17 : 15, padding: focusBounds.length ? [70, 70] : [48, 48] });
      setTimeout(() => map.invalidateSize(), 120);
    } catch (err) {
      console.warn(err);
      resetMap(containerId, container);
      fallbackSvg(container, vehicles, calls);
    }
  }

  function invalidateAll() {
    Object.values(liveMaps).forEach((map) => {
      try { map.invalidateSize(); } catch (_) {}
    });
  }

  function setMapProvider(provider) {
    const next = MAP_TILE_PROVIDERS[provider] ? provider : "google_road";
    window.JM_MAP_SETTINGS = Object.assign({}, window.JM_MAP_SETTINGS || {}, { provider: next });
    Object.entries(liveMaps).forEach(([containerId, map]) => {
      try {
        if (tileLayers[containerId]) map.removeLayer(tileLayers[containerId]);
        addBaseLayer(window.L, map, containerId);
      } catch (err) {
        console.warn("Falha ao trocar camada do mapa", err);
      }
    });
  }

  window.JM = window.JM || {};
  window.JM.mapa = { renderFleetMap, invalidateAll, setMapProvider };
}());
