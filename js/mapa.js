(function () {
  "use strict";

  const { esc, callRoutePoints, routeKm, geoJsonToLatLngs } = window.JM.utils;

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
      return `<g><circle cx="${x}" cy="${y}" r="18" fill="#38bdf8"/><text x="${x + 28}" y="${y + 5}" fill="#e2e8f0" font-size="14" font-weight="700">${esc(v.placa || v.id)}</text></g>`;
    }).join("");
    const callRows = Object.values(calls || {}).slice(0, 6).map((c, i) => `<text x="32" y="${330 + i * 24}" fill="#94a3b8" font-size="13">${esc(c.protocolo || c.cliente || "Chamado")}: ${esc(c.status || "")}</text>`).join("");
    container.innerHTML = `<svg class="fallback-map" viewBox="0 0 820 520" preserveAspectRatio="none" role="img" aria-label="Mapa operacional em fallback">
      <rect width="820" height="520" fill="#07111f"/>
      <path d="M80 380 C240 120 380 420 680 140" fill="none" stroke="#22c55e" stroke-width="5" stroke-linecap="round"/>
      ${rows}
      ${callRows}
    </svg>`;
  }

  const liveMaps = {};

  function resetMap(containerId, container) {
    if (liveMaps[containerId]) {
      try { liveMaps[containerId].remove(); } catch (_) {}
      delete liveMaps[containerId];
    }
    if (container && container._leaflet_id) {
      try { container._leaflet_id = null; } catch (_) {}
    }
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

  async function renderFleetMap(containerId, vehicles, calls, options) {
    options = options || {};
    const container = document.getElementById(containerId);
    if (!container) return;
    const located = Object.values(vehicles || {}).filter((v) => !v.deletedAt && v.location && Number.isFinite(Number(v.location.lat)) && Number.isFinite(Number(v.location.lng)));
    const routedCalls = Object.values(calls || {}).filter((c) => matchesFilter(c, options)).map((call) => {
      const forcedVehicle = options.selectedCallId && call.id === options.selectedCallId && options.selectedVehicleId ? vehicles && vehicles[options.selectedVehicleId] : null;
      const vehicle = forcedVehicle || vehicles && vehicles[call.vehicleId];
      return { call, vehicle, pts: callRoutePoints(call, vehicle) };
    }).filter((row) => row.pts.length);
    if (!located.length && !routedCalls.length) {
      resetMap(containerId, container);
      container.innerHTML = `<div style="height:100%;display:grid;place-items:center;padding:24px;text-align:center;background:#07111f">
        <div>
          <h3>Mapa aguardando dados reais</h3>
          <p class="muted small">Configure o tracker no <b>superadmin.html</b> ou registre um chamado com origem/destino validados para aparecer no mapa.</p>
        </div>
      </div>`;
      return;
    }
    try {
      const L = await loadLeaflet();
      resetMap(containerId, container);
      container.innerHTML = "";
      const map = L.map(containerId, { scrollWheelZoom: false });
      liveMaps[containerId] = map;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap"
      }).addTo(map);
      const bounds = [];
      located.forEach((vehicle) => {
        const p = [Number(vehicle.location.lat), Number(vehicle.location.lng)];
        bounds.push(p);
        const isSelected = options.selectedVehicleId && vehicle.id === options.selectedVehicleId;
        const marker = L.marker(p, { zIndexOffset: isSelected ? 900 : 0 }).addTo(map)
          .bindPopup(`<b>${esc(vehicle.placa || "")}</b><br>${esc(vehicle.apelido || vehicle.tipo || "")}<br>${esc(vehicle.trackerStatus || "")}`);
        if (isSelected) {
          L.circleMarker(p, { radius: 17, weight: 4, color: "#22c55e", fillOpacity: 0.08 }).addTo(map);
          marker.openPopup();
        }
      });
      for (const { call, pts } of routedCalls) {
        const callSelected = options.selectedCallId && call.id === options.selectedCallId;
        pts.forEach((p) => {
          const latlng = [p.point.lat, p.point.lng];
          bounds.push(latlng);
          const kindColor = p.kind === "origin" ? "#22c55e" : p.kind === "destination" ? "#ef4444" : p.kind === "vehicle" ? "#38bdf8" : "#f59e0b";
          L.circleMarker(latlng, { radius: callSelected ? 9 : 6, weight: callSelected ? 4 : 2, color: kindColor, fillOpacity: callSelected ? 0.45 : 0.25 }).addTo(map).bindPopup(`<b>${esc(p.label || "Ponto")}</b><br>${esc(call.protocolo || call.cliente || "Chamado")}`);
        });
        if (pts.length >= 2) await addRouteLayer(L, map, call, pts, bounds);
      }
      if (bounds.length === 1) map.setView(bounds[0], 14);
      else map.fitBounds(bounds, { padding: [32, 32] });
      setTimeout(() => map.invalidateSize(), 120);
    } catch (err) {
      console.warn(err);
      resetMap(containerId, container);
      fallbackSvg(container, vehicles, calls);
    }
  }

  window.JM = window.JM || {};
  window.JM.mapa = { renderFleetMap };
}());
