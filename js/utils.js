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
    const n = Number(String(value || 0).replace(/\./g, "").replace(",", ".")) || 0;
    return BRL.format(n);
  }

  function parseMoney(value) {
    if (typeof value === "number") return value;
    return Number(String(value || "0").replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".")) || 0;
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

  function uidSafe(value) {
    return String(value || "").toLowerCase().replace(/[.#$\[\]/]/g, "_");
  }

  function coords(lat, lng) {
    const la = Number(String(lat || "").replace(",", "."));
    const ln = Number(String(lng || "").replace(",", "."));
    if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
    return { lat: la, lng: ln };
  }

  function haversineKm(a, b) {
    if (!a || !b) return 0;
    const R = 6371;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const la1 = a.lat * Math.PI / 180;
    const la2 = b.lat * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function pointFrom(value) {
    if (!value) return null;
    if (value.coords) return pointFrom(value.coords);
    if (value.location) return pointFrom(value.location);
    return coords(value.lat, value.lng);
  }

  function callRoutePoints(call, vehicle) {
    const points = [];
    const vehiclePoint = pointFrom(vehicle && vehicle.location);
    const originPoint = pointFrom(call && (call.origem || call.origin));
    const destinationPoint = pointFrom(call && (call.destino || call.destination));
    if (vehiclePoint) points.push({ label: vehicle && (vehicle.placa || vehicle.apelido) || "Veículo", point: vehiclePoint });
    if (originPoint) points.push({ label: call && (call.originLabel || call.origem && call.origem.label) || "Origem", point: originPoint });
    if (destinationPoint) points.push({ label: call && (call.destLabel || call.destino && call.destino.label) || "Destino", point: destinationPoint });
    return points;
  }

  function routeKm(input, vehicle) {
    const points = Array.isArray(input) ? input : callRoutePoints(input, vehicle);
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += haversineKm(points[i - 1].point, points[i].point);
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

  function toast(message, type) {
    const box = $("toast");
    if (!box) return alert(message);
    box.textContent = message;
    box.className = "toast show " + (type || "info");
    clearTimeout(window.__jmToastTimer);
    window.__jmToastTimer = setTimeout(() => { box.className = "toast"; }, 3500);
  }

  function statusClass(status) {
    const key = String(status || "").toLowerCase();
    if (key.includes("final")) return "ok";
    if (key.includes("cancel")) return "danger";
    if (key.includes("atendimento") || key.includes("rota")) return "info";
    if (key.includes("despach")) return "warn";
    return "muted";
  }

  window.JM = window.JM || {};
  window.JM.utils = {
    $, $all, esc, money, parseMoney, dateTime, todayInput, slug, plateKey,
    uidSafe, coords, pointFrom, haversineKm, callRoutePoints, routeKm, mapsRouteUrl, toast, statusClass
  };
}());
