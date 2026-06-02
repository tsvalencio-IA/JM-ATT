(function () {
  "use strict";

  const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const DATE_TIME = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

  function $(id) {
    return document.getElementById(id);
  }

  function $all(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[m]));
  }

  function money(value) {
    const n = typeof value === "number" ? value : parseMoney(value);
    return BRL.format(n);
  }

  function parseMoney(value) {
    if (typeof value === "number") return value;
    let raw = String(value || "0").trim().replace(/[^\d,.-]/g, "");
    if (!raw) return 0;
    const negative = raw.includes("-");
    raw = raw.replace(/-/g, "");
    if (raw.includes(",")) {
      raw = raw.replace(/\./g, "").replace(",", ".");
    } else {
      const dotParts = raw.split(".");
      if (dotParts.length > 2) raw = dotParts.join("");
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : 0;
  }

  function dateTime(value) {
    if (!value) return "-";
    const d = value && typeof value.toDate === "function" ? value.toDate() : new Date(value);
    return Number.isNaN(d.getTime()) ? "-" : DATE_TIME.format(d);
  }

  function todayInput() {
    return new Date().toISOString().slice(0, 10);
  }

  function slug(value) {
    return String(value || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase().replace(/[^A-Z0-9]+/g, "")
      .trim();
  }

  function plateKey(value) {
    return slug(value || "").slice(0, 7);
  }

  function isValidPlate(value) {
    const plate = plateKey(value);
    return /^[A-Z]{3}[0-9]{4}$/.test(plate) || /^[A-Z]{3}[0-9][A-Z][0-9]{2}$/.test(plate);
  }

  function digits(value) {
    return String(value || "").replace(/\D+/g, "");
  }

  function maskPhone(value) {
    const d = digits(value).slice(0, 11);
    if (d.length <= 10) return d.replace(/^(\d{0,2})(\d{0,4})(\d{0,4}).*/, (_, a, b, c) => [a && "(" + a, a && a.length === 2 ? ") " : "", b, c && "-" + c].join(""));
    return d.replace(/^(\d{0,2})(\d{0,5})(\d{0,4}).*/, (_, a, b, c) => [a && "(" + a, a && a.length === 2 ? ") " : "", b, c && "-" + c].join(""));
  }

  function phoneWhatsappUrl(value, message) {
    const d = digits(value);
    if (d.length < 10) return "";
    const full = d.startsWith("55") ? d : "55" + d;
    return "https://wa.me/" + full + (message ? "?text=" + encodeURIComponent(message) : "");
  }

  function maskCpf(value) {
    return digits(value).slice(0, 11)
      .replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/\.(\d{3})(\d)/, ".$1-$2");
  }

  function maskCnpj(value) {
    return digits(value).slice(0, 14)
      .replace(/^(\d{2})(\d)/, "$1.$2")
      .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/\.(\d{3})(\d)/, ".$1/$2")
      .replace(/(\d{4})(\d)/, "$1-$2");
  }

  function validateCpf(value) {
    const d = digits(value);
    if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i += 1) sum += Number(d[i]) * (10 - i);
    let check = (sum * 10) % 11;
    if (check === 10) check = 0;
    if (check !== Number(d[9])) return false;
    sum = 0;
    for (let i = 0; i < 10; i += 1) sum += Number(d[i]) * (11 - i);
    check = (sum * 10) % 11;
    if (check === 10) check = 0;
    return check === Number(d[10]);
  }

  function validateCnpj(value) {
    const d = digits(value);
    if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
    const calc = (len) => {
      const weights = len === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
      const sum = weights.reduce((acc, weight, index) => acc + Number(d[index]) * weight, 0);
      const rest = sum % 11;
      return rest < 2 ? 0 : 11 - rest;
    };
    return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
  }

  const STATUS_DEFS = {
    aguardando_despacho: "Aguardando despacho",
    despachado: "Despachado",
    motorista_a_caminho: "Motorista a caminho",
    motorista_no_local: "Motorista no local",
    veiculo_carregado: "Veículo carregado",
    em_transporte: "Em transporte",
    entregue: "Entregue",
    finalizado: "Finalizado",
    cancelado: "Cancelado"
  };

  function statusKey(value) {
    const raw = String(value && (value.statusKey || value.status) || value || "").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!raw || raw === "novo") return "aguardando_despacho";
    if (raw.includes("cancel")) return "cancelado";
    if (raw.includes("final")) return "finalizado";
    if (raw.includes("entreg")) return "entregue";
    if (raw.includes("carreg")) return "veiculo_carregado";
    if (raw.includes("local")) return "motorista_no_local";
    if (raw.includes("transporte")) return "em_transporte";
    if (raw.includes("rota") || raw.includes("caminho") || raw.includes("atendimento")) return "motorista_a_caminho";
    if (raw.includes("despach")) return "despachado";
    return STATUS_DEFS[raw] ? raw : "aguardando_despacho";
  }

  function statusLabel(value) {
    return STATUS_DEFS[statusKey(value)] || "Aguardando despacho";
  }

  function isFinalStatus(value) {
    return ["finalizado", "cancelado"].includes(statusKey(value));
  }

  function uidSafe(value) {
    return String(value || "").toLowerCase().replace(/[.#$\[\]/]/g, "_");
  }

  function coords(lat, lng) {
    const la = Number(String(lat || "").replace(",", "."));
    const ln = Number(String(lng || "").replace(",", "."));
    if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
    return { lat: la, lng: ln };
  }

  function pointFrom(value) {
    if (!value) return null;
    if (value.coords) return pointFrom(value.coords);
    if (value.location) return pointFrom(value.location);
    if (Array.isArray(value) && value.length >= 2) return coords(value[0], value[1]);
    return coords(value.lat, value.lng);
  }

  function isPoint(value) {
    return !!pointFrom(value);
  }

  function roundPoint(value, precision) {
    const p = pointFrom(value);
    if (!p) return null;
    const pow = Math.pow(10, precision == null ? 5 : precision);
    return {
      lat: Math.round(p.lat * pow) / pow,
      lng: Math.round(p.lng * pow) / pow
    };
  }

  function haversineKm(a, b) {
    const pa = pointFrom(a);
    const pb = pointFrom(b);
    if (!pa || !pb) return 0;
    const R = 6371;
    const dLat = (pb.lat - pa.lat) * Math.PI / 180;
    const dLng = (pb.lng - pa.lng) * Math.PI / 180;
    const la1 = pa.lat * Math.PI / 180;
    const la2 = pb.lat * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function normalizeWaypoint(row, index) {
    const point = pointFrom(row && (row.coords || row.point || row));
    if (!point) return null;
    return {
      label: row && row.label || "Parada " + (index + 1),
      point
    };
  }

  function callRoutePoints(call, vehicle) {
    const points = [];
    const vehiclePoint = pointFrom(vehicle && (vehicle.location || vehicle.mobileLocation || vehicle.driverPhoneLocation || vehicle.phoneLocation));
    const phonePoint = pointFrom(call && (call.driverPhoneLocation || call.mobileLocation || call.driverLocation));
    const originPoint = pointFrom(call && (call.origem || call.origin));
    const destinationPoint = pointFrom(call && (call.destino || call.destination));
    const vehicleGpsSource = String(vehicle && (vehicle.gpsSource || vehicle.trackerStatus || vehicle.source || "") || "").toLowerCase();
    const vehicleIsPhoneGps = vehiclePoint && /driver_phone|mobile|celular/.test(vehicleGpsSource);
    if (phonePoint && (!vehiclePoint || call && call.phoneLocationActive)) points.push({ label: "GPS celular do motorista", point: phonePoint, kind: "driver_phone" });
    else if (vehiclePoint) points.push({ label: vehicleIsPhoneGps ? "GPS celular do motorista" : vehicle && (vehicle.placa || vehicle.apelido) || "Veículo", point: vehiclePoint, kind: vehicleIsPhoneGps ? "driver_phone" : "vehicle" });
    if (originPoint) points.push({ label: call && (call.originLabel || call.origem && call.origem.label) || "Origem", point: originPoint, kind: "origin" });
    (call && Array.isArray(call.routeWaypoints) ? call.routeWaypoints : []).forEach((row, index) => {
      const wp = normalizeWaypoint(row, index);
      if (wp) points.push({ label: wp.label, point: wp.point, kind: "waypoint" });
    });
    if (destinationPoint) points.push({ label: call && (call.destLabel || call.destino && call.destino.label) || "Destino", point: destinationPoint, kind: "destination" });
    return points;
  }

  function routeKm(input, vehicle) {
    const points = Array.isArray(input) ? input : callRoutePoints(input, vehicle);
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += haversineKm(points[i - 1].point || points[i - 1], points[i].point || points[i]);
    return total;
  }

  function geometryPointFromStore(pair) {
    if (Array.isArray(pair) && pair.length >= 2) return { lng: Number(pair[0]), lat: Number(pair[1]) };
    if (pair && typeof pair === "object") {
      const lng = Number(pair.lng ?? pair.longitude ?? pair.lon);
      const lat = Number(pair.lat ?? pair.latitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
    return null;
  }

  function geometryToFirestore(geometry) {
    if (!geometry || geometry.type !== "LineString" || !Array.isArray(geometry.coordinates)) return null;
    const coordinates = geometry.coordinates
      .map(geometryPointFromStore)
      .filter(Boolean)
      .map((p) => ({ lng: p.lng, lat: p.lat }));
    return coordinates.length >= 2 ? { type: "LineString", coordinates } : null;
  }

  function geometryToGeoJson(geometry) {
    if (!geometry || geometry.type !== "LineString" || !Array.isArray(geometry.coordinates)) return null;
    const coordinates = geometry.coordinates
      .map(geometryPointFromStore)
      .filter(Boolean)
      .map((p) => [p.lng, p.lat]);
    return coordinates.length >= 2 ? { type: "LineString", coordinates } : null;
  }

  function geoJsonToLatLngs(geometry) {
    const normalized = geometryToGeoJson(geometry);
    if (!normalized) return [];
    return normalized.coordinates
      .map((pair) => Array.isArray(pair) && pair.length >= 2 ? [Number(pair[1]), Number(pair[0])] : null)
      .filter((pair) => pair && Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
  }

  function geometryKm(geometry) {
    const latlngs = geoJsonToLatLngs(geometry);
    let total = 0;
    for (let i = 1; i < latlngs.length; i += 1) {
      total += haversineKm({ lat: latlngs[i - 1][0], lng: latlngs[i - 1][1] }, { lat: latlngs[i][0], lng: latlngs[i][1] });
    }
    return total;
  }

  function mapsRouteUrl(input, vehicle) {
    const points = Array.isArray(input) ? input : callRoutePoints(input, vehicle);
    const clean = points.map((p) => pointFrom(p.point || p)).filter(Boolean);
    if (clean.length < 2) return "";
    const q = new URLSearchParams({ api: "1", travelmode: "driving" });
    q.set("origin", clean[0].lat + "," + clean[0].lng);
    q.set("destination", clean[clean.length - 1].lat + "," + clean[clean.length - 1].lng);
    if (clean.length > 2) q.set("waypoints", clean.slice(1, -1).map((p) => p.lat + "," + p.lng).join("|"));
    return "https://www.google.com/maps/dir/?" + q.toString();
  }

  function normalizeUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^(maps\.app\.goo\.gl|goo\.gl\/maps|waze\.com|www\.google\.)/i.test(raw)) return "https://" + raw;
    return "";
  }

  function toast(message, type) {
    const box = $("toast");
    if (!box) return alert(message);
    box.textContent = message;
    box.className = "toast show " + (type || "info");
    clearTimeout(window.__jmToastTimer);
    window.__jmToastTimer = setTimeout(() => { box.className = "toast"; }, 3500);
  }

  function statusClass(status) {
    const key = statusKey(status);
    if (["finalizado", "entregue"].includes(key)) return "ok";
    if (key === "cancelado") return "danger";
    if (["motorista_a_caminho", "motorista_no_local", "veiculo_carregado", "em_transporte"].includes(key)) return "info";
    if (key === "despachado" || key === "aguardando_despacho") return "warn";
    return "muted";
  }

  function applyTheme(theme) {
    const next = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    document.documentElement.style.colorScheme = next;
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = next === "light" ? "#f4f7fb" : "#07110f";
    try { localStorage.setItem("jm-theme", next); } catch (_) {}
    return next;
  }

  function currentTheme() {
    try {
      const saved = localStorage.getItem("jm-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch (_) {}
    return "dark";
  }

  function setupThemeToggle() {
    const theme = applyTheme(currentTheme());
    if (document.querySelector(".theme-toggle")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn theme-toggle";
    button.setAttribute("aria-label", "Alternar modo claro e escuro");
    function render(next) {
      button.textContent = next === "light" ? "Modo escuro" : "Modo claro";
      button.title = button.textContent;
    }
    render(theme);
    button.addEventListener("click", () => render(applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light")));
    document.addEventListener("DOMContentLoaded", () => document.body.appendChild(button), { once: true });
    if (document.body) document.body.appendChild(button);
  }

  function setupCollapsiblePanels(root, options) {
    const scope = typeof root === "string" ? document.querySelector(root) : root || document;
    if (!scope) return;
    const cfg = Object.assign({ collapseOnMobile: true, openFirst: 2 }, options || {});
    const mobile = window.matchMedia && window.matchMedia("(max-width: 760px)").matches;
    const panels = Array.from(scope.querySelectorAll(".panel"));

    function directChild(parent, selector) {
      return Array.from(parent.children || []).find((el) => el.matches && el.matches(selector)) || null;
    }

    function panelKey(panel, title, index) {
      const raw = panel.id || (title.textContent || "painel").trim() || String(index);
      return raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
    }

    function invalidateVisuals() {
      setTimeout(() => {
        try { window.dispatchEvent(new Event("resize")); } catch (_) {}
        if (window.JM && window.JM.mapa && typeof window.JM.mapa.invalidateAll === "function") {
          try { window.JM.mapa.invalidateAll(); } catch (_) {}
        }
      }, 140);
    }

    panels.forEach((panel, index) => {
      if (!panel || panel.dataset.noCollapse === "true" || panel.classList.contains("no-collapse") || panel.closest(".login")) return;

      let head = directChild(panel, ".panel-collapse-head");
      let body = directChild(panel, ".panel-collapse-body");
      let title = head ? head.querySelector("h2,h3") : directChild(panel, "h2,h3");
      if (!title && body) title = body.querySelector(":scope > h2,:scope > h3");
      if (!title) return;

      if (!head) {
        head = document.createElement("div");
        head.className = "panel-collapse-head";
        panel.insertBefore(head, panel.firstChild);
      }
      if (title.parentElement !== head) head.insertBefore(title, head.firstChild);

      if (!body) {
        body = document.createElement("div");
        body.className = "panel-collapse-body";
        Array.from(panel.childNodes).forEach((node) => {
          if (node !== head && node !== body) body.appendChild(node);
        });
        panel.appendChild(body);
      } else {
        Array.from(panel.childNodes).forEach((node) => {
          if (node !== head && node !== body) body.appendChild(node);
        });
      }

      let button = Array.from(head.children || []).find((el) => el.classList && el.classList.contains("panel-collapse-toggle"));
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "btn panel-collapse-toggle";
        head.appendChild(button);
      }

      const rawTitle = (title.textContent || "painel").trim() || "painel";
      const keyBase = panelKey(panel, title, index);
      const storageKey = "jm-panel-collapsed:" + location.pathname + ":" + keyBase;
      const isMapPanel = !!body.querySelector(".map,.ops-map,#map,#driverMap,#operationMap,#fleetMap,#dashboardMap");
      const isCriticalForm = !!body.querySelector("#callForm,#financeForm,#paymentForm,#maintenanceForm,#driverProofForm,#driverExpenseForm,#driverReportForm,#superMobileGpsForm");

      panel.classList.add("is-collapsible");
      body.setAttribute("data-panel-body", "true");
      button.setAttribute("aria-label", "Minimizar ou maximizar " + rawTitle);
      button.setAttribute("title", "Minimizar ou maximizar este painel");

      function setCollapsed(collapsed, persist) {
        const isCollapsed = !!collapsed;
        panel.classList.toggle("is-collapsed", isCollapsed);
        panel.classList.toggle("collapsed", isCollapsed);
        body.hidden = isCollapsed;
        body.setAttribute("aria-hidden", String(isCollapsed));
        button.textContent = isCollapsed ? "Maximizar" : "Minimizar";
        button.setAttribute("aria-expanded", String(!isCollapsed));
        if (persist !== false) {
          try { localStorage.setItem(storageKey, isCollapsed ? "1" : "0"); } catch (_) {}
        }
        if (!isCollapsed) invalidateVisuals();
      }

      if (button.dataset.listenerReady !== "1") {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          setCollapsed(!panel.classList.contains("is-collapsed"));
        });
        button.dataset.listenerReady = "1";
      }

      let saved = null;
      try { saved = localStorage.getItem(storageKey); } catch (_) {}
      if (panel.dataset.collapsibleReady !== "1") {
        const shouldCollapse = saved === "1" || (saved == null && mobile && cfg.collapseOnMobile && index >= Number(cfg.openFirst || 0) && !isMapPanel && !isCriticalForm);
        setCollapsed(shouldCollapse, false);
        panel.dataset.collapsibleReady = "1";
      } else {
        setCollapsed(panel.classList.contains("is-collapsed") || body.hidden, false);
      }
    });
  }


  window.JM = window.JM || {};
  window.JM.utils = {
    $, $all, esc, money, parseMoney, dateTime, todayInput, slug, plateKey,
    isValidPlate, digits, maskPhone, phoneWhatsappUrl, maskCpf, maskCnpj, validateCpf, validateCnpj,
    STATUS_DEFS, statusKey, statusLabel, isFinalStatus,
    uidSafe, coords, pointFrom, isPoint, roundPoint, haversineKm, callRoutePoints,
    routeKm, geometryToFirestore, geometryToGeoJson, geoJsonToLatLngs, geometryKm, mapsRouteUrl, normalizeUrl, toast, statusClass,
    applyTheme, currentTheme, setupThemeToggle, setupCollapsiblePanels
  };
  setupThemeToggle();
}());
