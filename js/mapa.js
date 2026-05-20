(function () {
  "use strict";

  const { esc, callRoutePoints, routeKm } = window.JM.utils;

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
      js.onerror = () => reject(new Error("Nao foi possivel carregar Leaflet."));
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

  async function renderFleetMap(containerId, vehicles, calls) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const located = Object.values(vehicles || {}).filter((v) => v.location && Number.isFinite(Number(v.location.lat)) && Number.isFinite(Number(v.location.lng)));
    const routedCalls = Object.values(calls || {}).filter((c) => !["Finalizado", "Cancelado"].includes(c.status)).map((call) => ({
      call,
      vehicle: vehicles && vehicles[call.vehicleId],
      pts: callRoutePoints(call, vehicles && vehicles[call.vehicleId])
    })).filter((row) => row.pts.length);
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
        L.marker(p).addTo(map).bindPopup(`<b>${esc(vehicle.placa || "")}</b><br>${esc(vehicle.apelido || vehicle.tipo || "")}<br>${esc(vehicle.trackerStatus || "")}`);
      });
      routedCalls.forEach(({ call, pts }) => {
        pts.forEach((p) => {
          bounds.push([p.point.lat, p.point.lng]);
          L.circleMarker([p.point.lat, p.point.lng], { radius: 6, weight: 2 }).addTo(map).bindPopup(`<b>${esc(p.label || "Ponto")}</b><br>${esc(call.protocolo || call.cliente || "Chamado")}`);
        });
        if (pts.length >= 2) {
          const latlngs = pts.map((p) => [p.point.lat, p.point.lng]);
          L.polyline(latlngs, { color: "#22c55e", weight: 5, opacity: 0.75 }).addTo(map)
            .bindPopup(`${esc(call.protocolo || "Chamado")} - ${routeKm(pts).toFixed(1)} km estimados`);
        }
      });
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
