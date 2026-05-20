(function () {
  "use strict";

  const { $, $all, esc, money, parseMoney, dateTime, todayInput, plateKey, uidSafe, coords, pointFrom, callRoutePoints, routeKm, mapsRouteUrl, toast, statusClass } = window.JM.utils;
  const { auth, secondaryAuth, db, ts, arrayUnion, emailIsAdmin } = window.JM.firebase;
  const cfg = window.JM_CONFIG || {};
  const SYSTEM_SIGNATURE = "Powered by thIAguinho Soluções Digitais";
  const LOGIN_FLOW_VERSION = "jm-financeiro-frota-kpi-v13";
  let trackerTimer = null;
  let trackerBusy = false;

  const state = {
    user: null,
    profile: null,
    vehicles: {},
    calls: {},
    users: {},
    expenses: {},
    transactions: {},
    maintenance: {},
    auditLogs: {},
    settings: {},
    addresses: { origin: null, destination: null },
    smartRoute: null,
    editingCallId: null,
    editingUserId: null,
    editingTransactionId: null,
    editingMaintenanceId: null
  };

  const unsubscribers = [];
  const OFFICE_ROLES = ["admin", "finance", "gestor", "owner", "manager", "gerente", "auxiliar", "atendente"];
  const MANAGER_ROLES = ["admin", "finance", "gestor", "owner", "manager", "gerente"];
  const OWNER_ROLES = ["admin", "gestor", "owner", "manager"];
  const FINANCE_ROLES = ["admin", "finance", "gestor", "owner", "manager", "gerente"];
  const DRIVER_ROLES = ["driver", "motorista"];

  function normalizedRole(role) {
    return String(role || "").toLowerCase().trim();
  }

  function isOffice() {
    return state.profile && OFFICE_ROLES.includes(normalizedRole(state.profile.role));
  }

  function isAdmin() {
    return state.profile && MANAGER_ROLES.includes(normalizedRole(state.profile.role));
  }

  function currentRole() {
    return normalizedRole(state.profile && state.profile.role);
  }

  function isOwner() {
    return state.profile && OWNER_ROLES.includes(currentRole());
  }

  function canEditFinancial() {
    return state.profile && FINANCE_ROLES.includes(currentRole());
  }

  function canDeleteFinancial() {
    return state.profile && OWNER_ROLES.includes(currentRole());
  }

  function canApproveExpense() {
    return canEditFinancial();
  }

  function canDeleteCall() {
    return isOwner();
  }

  function canManageFleet() {
    return isOwner() || currentRole() === "gerente";
  }

  function canManageTracker() {
    return state.profile && MANAGER_ROLES.includes(normalizedRole(state.profile.role));
  }

  function activeCloudinaryConfig() {
    return Object.assign({}, cfg.cloudinary || {}, state.settings.cloudinary || {});
  }

  function mergeNonEmpty(base, override) {
    const out = Object.assign({}, base || {});
    Object.entries(override || {}).forEach(([key, value]) => {
      if (value === "" || value == null) return;
      if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
        out[key] = Object.assign({}, out[key] || {}, value);
      } else {
        out[key] = value;
      }
    });
    return out;
  }

  function activeMapSettings() {
    return mergeNonEmpty(cfg.map || {}, state.settings.map || state.settings.googleMaps || {});
  }

  function activeTrackerSettings() {
    return mergeNonEmpty(cfg.tracker || {}, state.settings.tracker || {});
  }

  function addressStatus(id, message, type) {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.className = "small geo-status " + (type || "muted");
  }

  function setAddress(kind, address) {
    const isOrigin = kind === "origin";
    const labelId = isOrigin ? "callOriginLabel" : "callDestLabel";
    const latId = isOrigin ? "callOriginLat" : "callDestLat";
    const lngId = isOrigin ? "callOriginLng" : "callDestLng";
    const statusId = isOrigin ? "originGeoStatus" : "destGeoStatus";
    const point = pointFrom(address && (address.coords || address));
    const normalized = {
      label: address && address.label || $(labelId).value.trim(),
      coords: point,
      placeId: address && address.placeId || "",
      source: address && address.source || "manual",
      resolvedAt: address && address.resolvedAt || new Date().toISOString()
    };
    state.addresses[kind] = normalized;
    if (normalized.label) $(labelId).value = normalized.label;
    if (point) {
      $(latId).value = String(point.lat);
      $(lngId).value = String(point.lng);
      addressStatus(statusId, "Endereço validado: " + normalized.label + " (" + point.lat.toFixed(6) + ", " + point.lng.toFixed(6) + ")", "ok");
    } else {
      addressStatus(statusId, "Endereço ainda sem coordenadas. Cole link do mapa com coordenadas ou informe latitude/longitude.", "danger");
    }
    state.smartRoute = null;
    renderSmartRouteBox();
    return normalized;
  }

  function addressFromInputs(kind) {
    const isOrigin = kind === "origin";
    const label = $(isOrigin ? "callOriginLabel" : "callDestLabel").value.trim();
    const point = coords($(isOrigin ? "callOriginLat" : "callDestLat").value, $(isOrigin ? "callOriginLng" : "callDestLng").value);
    const existing = state.addresses[kind] || {};
    if (!label && !point) return null;
    return {
      label: label || existing.label || "",
      coords: point || existing.coords || null,
      placeId: existing.placeId || "",
      source: existing.source || (point ? "manual_coords" : "manual_text"),
      resolvedAt: existing.resolvedAt || new Date().toISOString()
    };
  }

  function initializeAddressTools() {
    const gm = window.JM.googleMaps;
    if (!gm) return;
    if (!gm.isConfigured(activeMapSettings())) {
      addressStatus("originGeoStatus", "Modo gratuito ativo: cole link compartilhado do mapa ou coordenadas. Não usa API paga.", "warn");
      return;
    }
    gm.initAutocomplete("callOriginLabel", (addr) => setAddress("origin", addr), activeMapSettings()).catch((err) => addressStatus("originGeoStatus", err.message, "danger"));
    gm.initAutocomplete("callDestLabel", (addr) => setAddress("destination", addr), activeMapSettings()).catch((err) => addressStatus("destGeoStatus", err.message, "danger"));
    addressStatus("originGeoStatus", "Modo gratuito ativo: cole link do Google Maps/Waze ou coordenadas.", "ok");
    addressStatus("destGeoStatus", "Destino pode ser link compartilhado ou coordenadas.", "ok");
  }

  async function geocodeAddress(kind) {
    const gm = window.JM.googleMaps;
    const isOrigin = kind === "origin";
    const labelId = isOrigin ? "callOriginLabel" : "callDestLabel";
    const statusId = isOrigin ? "originGeoStatus" : "destGeoStatus";
    try {
      if (!gm || !gm.isConfigured(activeMapSettings())) throw new Error("Cole um link de mapa com coordenadas visíveis ou informe latitude/longitude.");
      addressStatus(statusId, "Lendo link/coordenadas...", "muted");
      const addr = await gm.geocode($(labelId).value.trim(), activeMapSettings());
      setAddress(kind, addr);
      toast((isOrigin ? "Origem" : "Destino") + " lido com coordenadas.", "ok");
    } catch (err) {
      addressStatus(statusId, err.message, "danger");
      toast(err.message, "danger");
    }
  }

  function useCurrentLocationAsOrigin() {
    if (!navigator.geolocation) return toast("Este navegador não liberou geolocalização.", "danger");
    addressStatus("originGeoStatus", "Capturando localização do aparelho...", "muted");
    navigator.geolocation.getCurrentPosition((pos) => {
      setAddress("origin", {
        label: "Localização atual do aparelho",
        coords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
        source: "browser_geolocation",
        resolvedAt: new Date().toISOString()
      });
      toast("Localização atual aplicada como origem.", "ok");
    }, (err) => {
      addressStatus("originGeoStatus", "Não foi possível obter localização: " + err.message, "danger");
    }, { enableHighAccuracy: true, timeout: 12000 });
  }

  function bestSmartRoute() {
    return state.smartRoute && state.smartRoute.rankings && state.smartRoute.rankings[0] || null;
  }

  function renderSmartRouteBox() {
    const box = $("smartRouteBox");
    if (!box) return;
    const route = state.smartRoute;
    if (!route || !route.rankings || !route.rankings.length) {
      box.innerHTML = "Informe a origem e clique em <b>Traçar rota inteligente</b>. O algoritmo usa posição do tracker, status do veículo, distância e tempo estimado.";
      return;
    }
    box.innerHTML = route.rankings.slice(0, 5).map((r, i) => {
      const v = r.vehicle || {};
      const badge = i === 0 ? '<span class="badge ok">RECOMENDADO</span>' : '<span class="badge info">Opção ' + (i + 1) + '</span>';
      const src = r.toOrigin && r.toOrigin.source === "free_leaflet_haversine" ? "mapa gratuito" : "estimativa";
      return `<div class="smart-route-card">
        <div>${badge} <b>${esc(v.placa || v.id || "Veículo")}</b> <span class="muted">${esc(v.apelido || v.tipo || "")}</span></div>
        <div>Até a origem: <b>${esc(r.toOrigin.distanceText || r.kmToOrigin.toFixed(1) + " km")}</b> · <b>${esc(r.toOrigin.durationTrafficText || r.toOrigin.durationText || r.minutesToOrigin + " min")}</b> · fonte: ${esc(src)}</div>
        ${r.serviceRoute ? `<div>Origem → destino: <b>${esc(r.serviceRoute.distanceText || "")}</b> · <b>${esc(r.serviceRoute.durationTrafficText || r.serviceRoute.durationText || "")}</b></div>` : ""}
        <div class="actions"><button class="btn primary" type="button" onclick="JM.app.applySmartVehicle('${esc(v.id)}')">Usar este veículo</button>${r.routeUrl ? `<a class="btn" target="_blank" href="${esc(r.routeUrl)}">Abrir rota</a>` : ""}</div>
      </div>`;
    }).join("");
  }

  async function calculateSmartRoute() {
    const gm = window.JM.googleMaps;
    const origin = addressFromInputs("origin");
    let destination = addressFromInputs("destination");
    if (!origin || !origin.coords) {
      if (origin && origin.label && gm && gm.isConfigured(activeMapSettings())) {
        await geocodeAddress("origin");
      }
    }
    const finalOrigin = addressFromInputs("origin");
    if (!finalOrigin || !finalOrigin.coords) return toast("Informe a origem por link do mapa ou latitude/longitude antes da rota inteligente.", "danger");
    if (destination && destination.label && !destination.coords && gm && gm.isConfigured(activeMapSettings())) {
      await geocodeAddress("destination");
      destination = addressFromInputs("destination");
    }
    const located = Object.values(state.vehicles || {}).filter((v) => pointFrom(v.location));
    if (!located.length) return toast("Nenhum veículo tem posição de tracker. Sincronize o tracker no superadmin primeiro.", "danger");
    $("smartRouteBox").innerHTML = "Calculando melhor veículo e tempo de rota...";
    try {
      const rankings = await gm.rankVehicles(state.vehicles, finalOrigin.coords, destination && destination.coords, activeMapSettings());
      state.smartRoute = { origin: finalOrigin, destination, rankings, calculatedAt: new Date().toISOString() };
      const best = bestSmartRoute();
      if (best && !$("callVehicle").value) $("callVehicle").value = best.vehicle.id;
      renderSmartRouteBox();
      toast("Rota inteligente calculada.", "ok");
    } catch (err) {
      $("smartRouteBox").innerHTML = `<span class="danger">${esc(err.message)}</span>`;
      toast(err.message, "danger");
    }
  }

  function applySmartVehicle(vehicleId) {
    if ($("callVehicle")) $("callVehicle").value = vehicleId || "";
    toast("Veículo aplicado ao chamado.", "ok");
  }

  function openGoogleRouteFromForm() {
    const vehicle = state.vehicles[$("callVehicle").value] || null;
    const origin = addressFromInputs("origin");
    const destination = addressFromInputs("destination");
    const points = [];
    if (vehicle && vehicle.location) points.push(vehicle.location);
    if (origin && origin.coords) points.push(origin.coords);
    if (destination && destination.coords) points.push(destination.coords);
    const url = window.JM.googleMaps && window.JM.googleMaps.routeUrl(points) || mapsRouteUrl(points);
    if (!url) return toast("Informe origem/destino e selecione veículo com posição para abrir a rota.", "danger");
    window.open(url, "_blank");
  }

  function showView(name) {
    $all(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
    $all("#navButtons button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    const titles = {
      dashboard: "Dashboard",
      chamados: "Chamados",
      mapa: "Mapa / Tracker",
      motorista: "Painel motorista",
      financeiro: "Financeiro",
      frota: "Frota",
      equipe: "Equipe"
    };
    $("pageTitle").textContent = titles[name] || name;
    document.body.classList.remove("menu-open");
    refreshMaps();
  }

  function bindNavigation() {
    $all("#navButtons button").forEach((btn) => {
      btn.onclick = () => showView(btn.dataset.view);
    });
    $("menuBtn").onclick = () => document.body.classList.toggle("menu-open");
    $("logoutBtn").onclick = () => auth.signOut();
  }

  function setSubmitText(formId, text) {
    const button = document.querySelector(`#${formId} button[type="submit"]`);
    if (button) button.textContent = text;
  }

  function setValue(id, value) {
    const el = $(id);
    if (el) el.value = value == null ? "" : String(value);
  }

  function resetCallForm() {
    if ($("callForm")) $("callForm").reset();
    state.editingCallId = null;
    state.addresses = { origin: null, destination: null };
    state.smartRoute = null;
    setSubmitText("callForm", "Registrar chamado");
    if ($("callCancelEdit")) $("callCancelEdit").classList.add("hidden");
    renderSmartRouteBox();
    addressStatus("originGeoStatus", "Aguardando link do mapa ou coordenadas.", "muted");
    addressStatus("destGeoStatus", "Destino opcional; pode ser link compartilhado ou coordenadas.", "muted");
  }

  function resetTeamForm() {
    if ($("teamForm")) $("teamForm").reset();
    state.editingUserId = null;
    if ($("teamEmail")) $("teamEmail").readOnly = false;
    if ($("teamPass")) $("teamPass").placeholder = "mínimo 6 caracteres";
    setSubmitText("teamForm", "Criar/atualizar equipe");
    if ($("teamCancelEdit")) $("teamCancelEdit").classList.add("hidden");
  }

  function reportSignature() {
    return `<div class="report-signature">${SYSTEM_SIGNATURE}</div>`;
  }

  function monthRange() {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    return { first, last };
  }

  function transactionAmount(t) {
    const gross = Number(t.grossAmount != null ? t.grossAmount : t.amount || 0);
    const discount = Number(t.discount || 0);
    const extra = Number(t.extra || 0);
    const net = Number(t.netAmount != null ? t.netAmount : gross - discount + extra);
    return Number.isFinite(net) ? net : 0;
  }

  function signedTransactionAmount(t) {
    const amount = transactionAmount(t);
    const type = normalizedRole(t && t.type);
    if (type === "saida") return -Math.abs(amount);
    if (type === "entrada") return Math.abs(amount);
    return amount;
  }

  function isWithinDate(value, from, to) {
    const d = String(value || "").slice(0, 10);
    if (!d) return true;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  }

  function filteredTransactions() {
    const from = $("finFilterFrom") && $("finFilterFrom").value || "";
    const to = $("finFilterTo") && $("finFilterTo").value || "";
    const vehicleId = $("finFilterVehicle") && $("finFilterVehicle").value || "";
    const driverId = $("finFilterDriver") && $("finFilterDriver").value || "";
    const type = $("finFilterType") && $("finFilterType").value || "";
    const status = $("finFilterStatus") && $("finFilterStatus").value || "";
    return Object.values(state.transactions || {}).filter((t) => {
      const d = t.date || t.competenceDate || t.createdAt;
      if (!isWithinDate(d, from, to)) return false;
      if (vehicleId && t.vehicleId !== vehicleId) return false;
      if (driverId && t.driverId !== driverId) return false;
      if (type && t.type !== type) return false;
      if (status && t.status !== status) return false;
      if (t.deletedAt) return false;
      return true;
    });
  }

  function financialSummary(rows) {
    return rows.reduce((acc, t) => {
      const amount = transactionAmount(t);
      if (normalizedRole(t.type) === "entrada") acc.revenue += Math.abs(amount);
      else if (normalizedRole(t.type) === "saida") acc.costs += Math.abs(amount);
      else acc.adjustments += signedTransactionAmount(t);
      return acc;
    }, { revenue: 0, costs: 0, adjustments: 0 });
  }

  function marginPercent(revenue, profit) {
    if (!revenue) return "0%";
    return (profit / revenue * 100).toFixed(1).replace(".", ",") + "%";
  }

  function driverLabel(id) {
    const u = state.users[id] || {};
    return u.nome || u.email || id || "-";
  }

  function vehicleLabel(id) {
    const v = state.vehicles[id] || {};
    return v.placa || v.apelido || id || "-";
  }

  function callLabel(id) {
    const c = state.calls[id] || {};
    return c.protocolo || c.cliente || id || "-";
  }

  async function writeAudit(action, collection, id, oldData, extra) {
    const payload = {
      action,
      collection,
      documentId: id,
      oldData: oldData || null,
      extra: extra || {},
      at: new Date().toISOString(),
      by: state.user && state.user.uid || "",
      byEmail: state.user && state.user.email || "",
      byName: state.profile && state.profile.nome || "",
      byRole: state.profile && state.profile.role || ""
    };
    await db.collection("auditLogs").add(payload).catch((err) => console.warn("Falha ao gravar auditLog", err));
  }

  function csvEscape(value) {
    return '"' + String(value == null ? "" : value).replace(/"/g, '""') + '"';
  }

  function downloadCsv(filename, headers, rows) {
    const csv = [headers.map(csvEscape).join(";")].concat(rows.map((row) => headers.map((h) => csvEscape(row[h])).join(";"))).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function resetFinanceForm() {
    if ($("financeForm")) $("financeForm").reset();
    state.editingTransactionId = null;
    setSubmitText("financeForm", "Salvar financeiro");
    if ($("finCancelEdit")) $("finCancelEdit").classList.add("hidden");
    if ($("finDate")) $("finDate").value = todayInput();
  }

  function resetMaintenanceForm() {
    if ($("maintenanceForm")) $("maintenanceForm").reset();
    state.editingMaintenanceId = null;
    setSubmitText("maintenanceForm", "Salvar manutenção e lançar custo");
    if ($("maintCancelEdit")) $("maintCancelEdit").classList.add("hidden");
    if ($("maintDate")) $("maintDate").value = todayInput();
  }

  function transactionPayloadFromForm() {
    const gross = parseMoney($("finAmount").value);
    const discount = parseMoney($("finDiscount").value);
    const extra = parseMoney($("finExtra").value);
    const net = gross - discount + extra;
    return {
      type: $("finType").value,
      date: $("finDate").value || todayInput(),
      competenceDate: $("finDate").value || todayInput(),
      dueDate: $("finDueDate").value || "",
      paidDate: $("finPaidDate").value || "",
      description: $("finDesc").value.trim(),
      category: $("finCategory").value,
      costCenter: $("finCostCenter").value,
      party: $("finParty").value.trim(),
      paymentMethod: $("finPaymentMethod").value,
      grossAmount: gross,
      discount,
      extra,
      amount: net,
      netAmount: net,
      status: $("finStatus").value,
      callId: $("finCall").value,
      vehicleId: $("finVehicle").value,
      driverId: $("finDriver").value,
      notes: $("finNotes").value.trim(),
      updatedAt: new Date().toISOString(),
      updatedBy: state.user.uid
    };
  }


  function gestorAccessAllowedByConfig(user) {
    const authCfg = cfg.auth || {};
    // Mantém a trava por lista de e-mails quando ela existir.
    // Se a lista estiver vazia/removida, o sistema permite o primeiro gestor criar o perfil.
    const list = (authCfg.adminEmails || []).map((e) => String(e).toLowerCase().trim()).filter(Boolean);
    if (!list.length) return { allowed: true, role: "admin", source: "config-empty" };
    return emailIsAdmin(user.email) ? { allowed: true, role: "admin", source: "config" } : { allowed: false };
  }

  async function gestorAccessAllowedByRegistry(user) {
    const email = String(user && user.email || "").toLowerCase().trim();
    if (!email) return { allowed: false };
    try {
      const snap = await db.collection("managerAccess").doc(email).get();
      if (!snap.exists) return { allowed: false };
      const data = snap.data() || {};
      const role = normalizedRole(data.role || "admin");
      if (data.active === false) return { allowed: false, reason: "inactive" };
      if (!OFFICE_ROLES.includes(role)) return { allowed: false, reason: "not-manager-role" };
      return { allowed: true, role, source: "managerAccess" };
    } catch (err) {
      console.warn("Falha ao verificar managerAccess", err);
      return { allowed: false, error: err };
    }
  }

  async function emailReservedForManager(email) {
    const normalized = String(email || "").toLowerCase().trim();
    if (!normalized) return false;
    if (emailIsAdmin(normalized)) return true;
    try {
      const snap = await db.collection("managerAccess").doc(normalized).get();
      return snap.exists && (snap.data() || {}).active !== false;
    } catch (err) {
      console.warn("Falha ao verificar gestor reservado", err);
      return false;
    }
  }

  async function saveGestorProfile(ref, profile, existingData) {
    const payload = existingData ? profile : Object.assign({ createdAt: ts() }, profile);
    await ref.set(payload, { merge: true });
    return { id: profile.uid, ...(existingData || {}), ...profile };
  }

  async function ensureGestorProfile(user) {
    const ref = db.collection("users").doc(user.uid);
    const snap = await ref.get();
    const current = snap.exists ? { id: user.uid, ...snap.data() } : null;

    if (current && current.active === false) {
      throw new Error("Este usuário está inativo no cadastro da JM Guinchos.");
    }

    const baseProfile = {
      uid: user.uid,
      email: user.email,
      nome: (current && current.nome) || user.displayName || user.email.split("@")[0],
      active: true,
      updatedAt: ts()
    };

    if (current && OFFICE_ROLES.includes(normalizedRole(current.role))) {
      return { ...current, role: normalizedRole(current.role) };
    }

    const configAccess = gestorAccessAllowedByConfig(user);
    const registryAccess = configAccess.allowed ? configAccess : await gestorAccessAllowedByRegistry(user);
    if (!registryAccess.allowed) {
      throw new Error("Este e-mail não está liberado como gestor. Crie/libere o gestor no superadmin antes de acessar o jm.html.");
    }

    // Correção definitiva do bug: jm.html é painel gestor.
    // Se o usuário foi criado como driver/motorista por fluxo antigo, repara para admin/financeiro
    // usando a autorização por e-mail gravada pelo superadmin em managerAccess/{email}.
    const repairedProfile = {
      ...baseProfile,
      role: registryAccess.role || "admin",
      loginFixedAt: new Date().toISOString(),
      loginFlowVersion: LOGIN_FLOW_VERSION,
      managerAccessSource: registryAccess.source || "unknown"
    };

    try {
      return await saveGestorProfile(ref, repairedProfile, current || null);
    } catch (err) {
      if (err && err.code === "permission-denied") {
        throw new Error("O login foi aceito, mas o Firestore bloqueou a correção do perfil. Publique as novas firestore.rules deste ZIP ou altere o documento users/" + user.uid + " para role: admin.");
      }
      throw err;
    }
  }



  function setTrackerStatus(message, type) {
    const el = $("trackerStatus");
    if (!el) return;
    el.textContent = message;
    el.className = "muted small " + (type || "");
  }

  async function syncTrackerNow(manual) {
    const tracker = activeTrackerSettings();
    if (!tracker.endpoint || !tracker.token) {
      setTrackerStatus("Tracker sem endpoint/token. Configure no superadmin.", "warn");
      if (manual) toast("Configure endpoint e token do Tracker no superadmin.", "danger");
      return [];
    }
    if (!canManageTracker()) {
      setTrackerStatus("Tracker ativo somente para gestor/gerente sincronizar.", "warn");
      return [];
    }
    if (trackerBusy) return [];
    trackerBusy = true;
    try {
      setTrackerStatus("Sincronizando Tracker RAFA...", "info");
      const positions = await window.JM.tracker.syncTrackerToFirestore(tracker, db, state.vehicles);
      const matched = positions.filter((p) => p.trackerMatched).length;
      const unmapped = positions.length - matched;
      const now = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      const detail = unmapped > 0 ? ` (${unmapped} sem vinculo com placa; ajuste o deviceId no superadmin)` : "";
      setTrackerStatus(`Tracker RAFA sincronizado: ${positions.length} posição(ões), ${matched} vinculada(s) às ${now}${detail}.`, unmapped > 0 ? "warn" : "ok");
      if (manual) toast(`${positions.length} posição(ões) sincronizada(s), ${matched} vinculada(s).${detail}`, unmapped > 0 ? "warn" : "ok");
      return positions;
    } catch (err) {
      console.error(err);
      setTrackerStatus("Falha no Tracker: " + (err && err.message || err), "danger");
      if (manual) toast("Falha no Tracker: " + (err && err.message || err), "danger");
      return [];
    } finally {
      trackerBusy = false;
    }
  }

  function restartTrackerAutoSync() {
    if (trackerTimer) {
      clearInterval(trackerTimer);
      trackerTimer = null;
    }
    const tracker = activeTrackerSettings();
    if (!tracker.endpoint || !tracker.token) {
      setTrackerStatus("Tracker aguardando endpoint/token no superadmin.", "warn");
      return;
    }
    const polling = Math.max(15000, Number(tracker.pollingMs || 30000));
    setTrackerStatus("Tracker configurado. Atualização automática a cada " + Math.round(polling / 1000) + "s.", "ok");
    syncTrackerNow(false);
    trackerTimer = setInterval(() => syncTrackerNow(false), polling);
  }


  function listenCollection(name, target) {
    const unsub = db.collection(name).onSnapshot((snap) => {
      const rows = {};
      snap.forEach((doc) => { rows[doc.id] = { id: doc.id, ...doc.data() }; });
      state[target] = rows;
      renderAll();
    }, (err) => {
      console.error(err);
      toast("Falha ao ouvir " + name + ": " + err.message, "danger");
    });
    unsubscribers.push(unsub);
  }

  function startListeners() {
    unsubscribers.splice(0).forEach((fn) => fn());
    const baseCollections = ["vehicles", "calls", "users"];
    if (isAdmin()) baseCollections.push("expenses", "transactions", "maintenance", "auditLogs");
    baseCollections.forEach((name) => listenCollection(name, name));
    const settingsUnsub = db.collection("settings").doc("integrations").onSnapshot((snap) => {
      state.settings = snap.exists ? snap.data() : {};
      initializeAddressTools();
      restartTrackerAutoSync();
      renderAll();
    });
    unsubscribers.push(settingsUnsub);
  }

  function stopListeners() {
    unsubscribers.splice(0).forEach((fn) => fn());
    if (trackerTimer) { clearInterval(trackerTimer); trackerTimer = null; }
  }

  function applyRoleVisibility() {
    const allowed = isAdmin();
    ["financeiro", "frota", "equipe"].forEach((view) => {
      const btn = document.querySelector(`#navButtons button[data-view="${view}"]`);
      if (btn) btn.classList.toggle("hidden", !allowed);
    });
    // Importante: nunca redirecionar o jm.html para motorista.html.
    if (!allowed) showView("dashboard");
  }

  auth.onAuthStateChanged(async (user) => {
    stopListeners();
    state.user = user || null;
    state.profile = null;
    if (!user) {
      $("loginView").classList.remove("hidden");
      $("appView").classList.add("hidden");
      return;
    }

    try {
      state.profile = await ensureGestorProfile(user);
      $("loginView").classList.add("hidden");
      $("appView").classList.remove("hidden");
      $("userBox").innerHTML = `<b>${esc(state.profile.nome || user.email)}</b><br>${esc(user.email)}<br><span class="badge info">${esc(state.profile.role)}</span>`;
      applyRoleVisibility();
      startListeners();
    } catch (err) {
      $("appView").classList.add("hidden");
      $("loginView").classList.remove("hidden");
      $("loginError").textContent = err && err.message ? err.message : "Acesso de gestor não autorizado.";
      await auth.signOut().catch(() => {});
    }
  });

  $("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    $("loginError").textContent = "";
    try {
      await auth.signInWithEmailAndPassword($("loginEmail").value.trim(), $("loginPass").value);
    } catch (err) {
      $("loginError").textContent = friendlyAuthError(err);
    }
  };

  function friendlyAuthError(err) {
    const code = err && err.code || "";
    if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
      return "Usuário ou senha inválidos. O acesso de gestor deve existir no Firebase Authentication.";
    }
    if (code === "auth/operation-not-allowed") {
      return "Ative o provedor E-mail/Senha no Firebase Authentication.";
    }
    if (code === "auth/too-many-requests") {
      return "Muitas tentativas. Aguarde alguns minutos ou redefina a senha no Firebase.";
    }
    return "Acesso negado: " + (err && err.message || "falha de autenticação");
  }

  function renderAll() {
    renderSelects();
    renderDashboard();
    renderCalls();
    renderVehicles();
    renderTeam();
    if ($("driverCalls")) renderDriverPanel();
    renderFinance();
    refreshMaps();
  }

  function setOptionsPreservingValue(id, html) {
    const el = $(id);
    if (!el) return;
    const current = el.value;
    el.innerHTML = html;
    if (current && Array.from(el.options).some((opt) => opt.value === current)) el.value = current;
  }

  function renderSelects() {
    const vehicleOptions = Object.values(state.vehicles).map((v) => `<option value="${esc(v.id)}">${esc(v.placa || v.id)} - ${esc(v.apelido || v.tipo || "")}</option>`).join("");
    const vehicleAllOptions = `<option value="">Todos/sem vínculo</option>${vehicleOptions}`;
    setOptionsPreservingValue("callVehicle", `<option value="">Selecione</option>${vehicleOptions}`);
    setOptionsPreservingValue("expenseVehicle", `<option value="">Selecione</option>${vehicleOptions}`);
    setOptionsPreservingValue("finVehicle", vehicleAllOptions);
    setOptionsPreservingValue("finFilterVehicle", vehicleAllOptions);
    setOptionsPreservingValue("maintVehicle", `<option value="">Selecione</option>${vehicleOptions}`);
    const drivers = Object.values(state.users).filter((u) => u.active !== false && DRIVER_ROLES.includes(normalizedRole(u.role)));
    const driverOptions = drivers.map((u) => `<option value="${esc(u.id)}">${esc(u.nome || u.email)}</option>`).join("");
    setOptionsPreservingValue("callDriver", `<option value="">Selecione</option>` + driverOptions);
    setOptionsPreservingValue("finDriver", `<option value="">Todos/sem vínculo</option>` + driverOptions);
    setOptionsPreservingValue("finFilterDriver", `<option value="">Todos</option>` + driverOptions);
    const callsOptions = Object.values(state.calls).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).map((c) => `<option value="${esc(c.id)}">${esc(c.protocolo || c.cliente)}</option>`).join("");
    setOptionsPreservingValue("finCall", `<option value="">Sem chamado</option>` + callsOptions);
    const myCalls = Object.values(state.calls).filter((c) => c.driverId === state.user?.uid && !["Finalizado", "Cancelado"].includes(c.status));
    setOptionsPreservingValue("expenseCall", `<option value="">Sem chamado</option>` + myCalls.map((c) => `<option value="${esc(c.id)}">${esc(c.protocolo || c.cliente)}</option>`).join(""));
  }

  function renderDashboard() {
    const calls = Object.values(state.calls);
    const active = calls.filter((c) => !["Finalizado", "Cancelado"].includes(c.status));
    const range = monthRange();
    const monthRows = Object.values(state.transactions).filter((t) => !t.deletedAt && isWithinDate(t.date || t.createdAt, range.first, range.last));
    const summary = financialSummary(monthRows);
    const profit = summary.revenue - summary.costs + summary.adjustments;
    const pendingExpenses = Object.values(state.expenses).filter((e) => e.status === "pendente").reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const online = Object.values(state.vehicles).filter((v) => v.location && v.lastTrackerAt).length;
    $("kpiActiveCalls").textContent = active.length;
    $("kpiRevenue").textContent = money(summary.revenue);
    $("kpiExpenses").textContent = money(pendingExpenses);
    $("kpiOnline").textContent = online;
    if ($("finKpiRevenue")) $("finKpiRevenue").textContent = money(summary.revenue);
    if ($("finKpiCosts")) $("finKpiCosts").textContent = money(summary.costs);
    if ($("finKpiProfit")) $("finKpiProfit").textContent = money(profit);
    if ($("finKpiMargin")) $("finKpiMargin").textContent = marginPercent(summary.revenue, profit);
    const events = calls.flatMap((c) => (c.timeline || []).map((t) => ({ ...t, call: c }))).sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 10);
    $("timelineBox").innerHTML = events.length ? events.map((e) => `<div class="timeline-item"><b>${esc(e.call.protocolo || e.call.cliente || "Chamado")}</b><br><span>${esc(e.text || "")}</span><br><small>${dateTime(e.at)}</small></div>`).join("") : `<p class="muted">Sem eventos ainda.</p>`;
  }

  function renderCalls() {
    const rows = Object.values(state.calls).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    if (!rows.length) return $("callsTable").innerHTML = `<p class="muted">Nenhum chamado registrado.</p>`;
    $("callsTable").innerHTML = `<table><thead><tr><th>Protocolo</th><th>Cliente</th><th>Origem/Destino</th><th>Veículo</th><th>Status</th><th>Ações</th></tr></thead><tbody>` + rows.map((c) => {
      const vehicle = state.vehicles[c.vehicleId] || {};
      const driver = state.users[c.driverId] || {};
      const url = c.routeUrl || mapsRouteUrl(c, vehicle);
      const km = routeKm(c, vehicle);
      const metric = c.routeMetrics && c.routeMetrics.bestToOrigin && c.routeMetrics.bestToOrigin.distanceText || (km ? km.toFixed(1).replace(".", ",") + " km" : "Sem rota");
      const adminActions = isAdmin() ? `<button class="btn" onclick="JM.app.editCall('${esc(c.id)}')">Editar</button><button class="btn" onclick="JM.app.viewCallDre('${esc(c.id)}')">DRE</button>${canDeleteCall() ? `<button class="btn danger" onclick="JM.app.deleteCall('${esc(c.id)}')">Excluir</button>` : `<button class="btn danger" onclick="JM.app.cancelCall('${esc(c.id)}')">Cancelar</button>`}` : "";
      return `<tr>
        <td><b>${esc(c.protocolo || c.id)}</b><br><span class="muted small">${dateTime(c.createdAt)}</span></td>
        <td>${esc(c.cliente || "")}<br><span class="muted small">${esc(c.phone || "")}</span></td>
        <td><span class="small">${esc(c.originLabel || c.origem && c.origem.label || "-")}</span><br><span class="muted small">→ ${esc(c.destLabel || c.destino && c.destino.label || "-")}</span><br><b>${esc(metric)}</b>${url ? `<br><a class="info small" target="_blank" href="${esc(url)}">Abrir rota no Maps</a>` : ""}</td>
        <td>${esc(vehicle.placa || "-")}<br><span class="muted small">${esc(driver.nome || driver.email || "Sem motorista")}</span></td>
        <td><span class="badge ${statusClass(c.status)}">${esc(c.status || "Novo")}</span><br><b>${money(c.valor || 0)}</b></td>
        <td class="row-actions"><button class="btn good" onclick="JM.app.setCallStatus('${esc(c.id)}','Despachado')">Despachar</button><button class="btn primary" onclick="JM.app.setCallStatus('${esc(c.id)}','Em Atendimento')">Atender</button><button class="btn" onclick="JM.app.setCallStatus('${esc(c.id)}','Finalizado')">Finalizar</button>${adminActions}</td>
      </tr>`;
    }).join("") + `</tbody></table>`;
  }

  $("callForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!isOffice()) return toast("Somente equipe autorizada pode registrar chamado.", "danger");
    const originAddress = addressFromInputs("origin");
    const destinationAddress = addressFromInputs("destination");
    if (!originAddress || !originAddress.coords) {
      return toast("Antes de registrar, informe a origem por link de mapa ou latitude/longitude real.", "danger");
    }
    const best = bestSmartRoute();
    const selectedVehicle = state.vehicles[$("callVehicle").value] || null;
    const routePoints = [];
    if (selectedVehicle && selectedVehicle.location) routePoints.push(selectedVehicle.location);
    routePoints.push(originAddress.coords);
    if (destinationAddress && destinationAddress.coords) routePoints.push(destinationAddress.coords);
    const now = new Date().toISOString();
    const baseData = {
      cliente: $("callClient").value.trim(),
      phone: $("callPhone").value.trim(),
      serviceType: $("callType").value,
      valor: parseMoney($("callPrice").value),
      vehicleId: $("callVehicle").value,
      driverId: $("callDriver").value,
      originLabel: originAddress.label,
      destLabel: destinationAddress && destinationAddress.label || "",
      origin: originAddress.coords,
      destination: destinationAddress && destinationAddress.coords || null,
      origem: originAddress,
      destino: destinationAddress || null,
      routeUrl: window.JM.googleMaps && window.JM.googleMaps.routeUrl(routePoints) || mapsRouteUrl(routePoints),
      routeMetrics: best ? {
        recommendedVehicleId: best.vehicle && best.vehicle.id || "",
        recommendedVehiclePlate: best.vehicle && best.vehicle.placa || "",
        bestToOrigin: best.toOrigin || null,
        serviceRoute: best.serviceRoute || null,
        calculatedAt: state.smartRoute && state.smartRoute.calculatedAt || new Date().toISOString(),
        algorithm: "tracker_position + free_leaflet_haversine_or_fallback + status_penalty"
      } : null,
      notes: $("callNotes").value.trim()
    };
    if (state.editingCallId) {
      const current = state.calls[state.editingCallId] || {};
      await db.collection("calls").doc(state.editingCallId).set(Object.assign({}, baseData, {
        status: current.status || ($("callDriver").value ? "Despachado" : "Novo"),
        updatedAt: now,
        updatedBy: state.user.uid,
        timeline: arrayUnion({ at: now, by: state.profile.nome || state.user.email, text: "Chamado editado pelo gestor" })
      }), { merge: true });
      resetCallForm();
      toast("Chamado atualizado.", "ok");
      return;
    }
    const protocolo = "JM-" + now.replace(/\D/g, "").slice(2, 14);
    await db.collection("calls").add(Object.assign({}, baseData, {
      protocolo,
      status: $("callDriver").value ? "Despachado" : "Novo",
      createdAt: now,
      createdBy: state.user.uid,
      timeline: [{ at: now, by: state.profile.nome || state.user.email, text: "Chamado criado com endereço validado e rota inteligente" }]
    }));
    resetCallForm();
    toast("Chamado registrado com dados de rota.", "ok");
  };

  async function setCallStatus(id, status) {
    if (!isOffice()) return toast("Somente equipe autorizada pode alterar status.", "danger");
    const call = state.calls[id];
    if (!call) return;
    const updates = {
      status,
      updatedAt: new Date().toISOString(),
      timeline: arrayUnion({ at: new Date().toISOString(), by: state.profile.nome || state.user.email, text: "Status alterado para " + status })
    };
    if (status === "Finalizado" && Number(call.valor || 0) > 0 && !call.financeCreated && isAdmin()) {
      updates.financeCreated = true;
      const callValue = Number(call.valor || 0);
      await db.collection("transactions").add({
        type: "entrada",
        date: todayInput(),
        competenceDate: todayInput(),
        description: `Chamado ${call.protocolo || id} - ${call.cliente || ""}`,
        category: "Receita de chamado",
        costCenter: "Operacional",
        grossAmount: callValue,
        amount: callValue,
        netAmount: callValue,
        status: "A receber",
        callId: id,
        vehicleId: call.vehicleId || "",
        driverId: call.driverId || "",
        party: call.cliente || "",
        createdAt: new Date().toISOString(),
        createdBy: state.user.uid
      });
    }
    await db.collection("calls").doc(id).update(updates);
    toast("Status atualizado.", "ok");
  }

  function editCall(id) {
    if (!isAdmin()) return toast("Somente gestor/dono pode editar chamados.", "danger");
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado.", "danger");
    state.editingCallId = id;
    showView("chamados");
    setValue("callClient", call.cliente || "");
    setValue("callPhone", call.phone || "");
    setValue("callType", call.serviceType || "Guincho");
    setValue("callPrice", call.valor || "");
    setValue("callVehicle", call.vehicleId || "");
    setValue("callDriver", call.driverId || "");
    setValue("callNotes", call.notes || "");
    const originPoint = pointFrom(call.origem || call.origin);
    const destPoint = pointFrom(call.destino || call.destination);
    state.addresses.origin = {
      label: call.originLabel || call.origem && call.origem.label || "",
      coords: originPoint,
      source: call.origem && call.origem.source || "edit",
      resolvedAt: call.origem && call.origem.resolvedAt || new Date().toISOString()
    };
    state.addresses.destination = {
      label: call.destLabel || call.destino && call.destino.label || "",
      coords: destPoint,
      source: call.destino && call.destino.source || "edit",
      resolvedAt: call.destino && call.destino.resolvedAt || new Date().toISOString()
    };
    setValue("callOriginLabel", state.addresses.origin.label);
    setValue("callOriginLat", originPoint && originPoint.lat);
    setValue("callOriginLng", originPoint && originPoint.lng);
    setValue("callDestLabel", state.addresses.destination.label);
    setValue("callDestLat", destPoint && destPoint.lat);
    setValue("callDestLng", destPoint && destPoint.lng);
    state.smartRoute = null;
    renderSmartRouteBox();
    setSubmitText("callForm", "Salvar alterações do chamado");
    if ($("callCancelEdit")) $("callCancelEdit").classList.remove("hidden");
    toast("Edite o chamado e salve as alterações.", "ok");
  }

  async function cancelCall(id) {
    if (!isAdmin()) return toast("Somente gestor/gerente pode cancelar chamados.", "danger");
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado.", "danger");
    const motivo = window.prompt("Motivo do cancelamento do chamado:", "Cancelado pelo gestor") || "Cancelado pelo gestor";
    await writeAudit("cancel", "calls", id, call, { motivo });
    await db.collection("calls").doc(id).update({
      status: "Cancelado",
      canceledAt: new Date().toISOString(),
      canceledBy: state.user.uid,
      cancelReason: motivo,
      timeline: arrayUnion({ at: new Date().toISOString(), by: state.profile.nome || state.user.email, text: "Chamado cancelado: " + motivo })
    });
    toast("Chamado cancelado com auditoria.", "ok");
  }

  function viewCallDre(id) {
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado.", "danger");
    const txs = Object.values(state.transactions).filter((t) => t.callId === id && !t.deletedAt);
    const approvedExpenses = Object.values(state.expenses).filter((e) => e.callId === id && e.status === "aprovado");
    const receita = txs.filter((t) => t.type === "entrada").reduce((sum, t) => sum + transactionAmount(t), 0) || Number(call.valor || 0);
    const saidasTx = txs.filter((t) => t.type === "saida").reduce((sum, t) => sum + Math.abs(transactionAmount(t)), 0);
    const saidasExp = approvedExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const custo = Math.max(saidasTx, saidasExp);
    const lucro = receita - custo;
    window.alert([
      `DRE do chamado ${call.protocolo || id}`,
      `Cliente: ${call.cliente || "-"}`,
      `Veículo: ${vehicleLabel(call.vehicleId)}`,
      `Motorista: ${driverLabel(call.driverId)}`,
      `Receita: ${money(receita)}`,
      `Custos vinculados: ${money(custo)}`,
      `Lucro bruto: ${money(lucro)}`,
      `Margem: ${marginPercent(receita, lucro)}`
    ].join("\n"));
  }

  async function deleteCall(id) {
    if (!canDeleteCall()) return toast("Somente gestor/dono pode excluir chamados definitivamente.", "danger");
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado.", "danger");
    const label = call.protocolo || call.cliente || id;
    const motivo = window.prompt(`Motivo obrigatório para excluir o chamado ${label}:`, "Exclusão autorizada pelo gestor") || "Exclusão autorizada pelo gestor";
    if (!window.confirm(`Excluir definitivamente o chamado ${label}? Esta ação remove o chamado e os lançamentos financeiros vinculados, mas grava auditoria.`)) return;
    await writeAudit("delete", "calls", id, call, { motivo });
    const linkedTransactions = await db.collection("transactions").where("callId", "==", id).get();
    const batch = db.batch();
    batch.delete(db.collection("calls").doc(id));
    linkedTransactions.forEach((doc) => {
      batch.set(db.collection("auditLogs").doc(), {
        action: "delete-linked-transaction-by-call-delete",
        collection: "transactions",
        documentId: doc.id,
        oldData: doc.data(),
        extra: { callId: id, motivo },
        at: new Date().toISOString(),
        by: state.user.uid,
        byEmail: state.user.email,
        byName: state.profile.nome || "",
        byRole: state.profile.role || ""
      });
      batch.delete(doc.ref);
    });
    await batch.commit();
    if (state.editingCallId === id) resetCallForm();
    toast("Chamado excluído com auditoria.", "ok");
  }

  function vehicleFinancials(vehicleId) {
    const txs = Object.values(state.transactions).filter((t) => t.vehicleId === vehicleId && !t.deletedAt);
    const summary = financialSummary(txs);
    const profit = summary.revenue - summary.costs + summary.adjustments;
    const calls = Object.values(state.calls).filter((c) => c.vehicleId === vehicleId);
    const maint = Object.values(state.maintenance).filter((m) => m.vehicleId === vehicleId);
    return { revenue: summary.revenue, costs: summary.costs, profit, calls: calls.length, maintenance: maint.length };
  }

  function renderVehicles() {
    const rows = Object.values(state.vehicles).sort((a, b) => String(a.placa || "").localeCompare(String(b.placa || "")));
    if ($("fleetKpiBox")) {
      const totals = rows.reduce((acc, v) => {
        const fin = vehicleFinancials(v.id);
        acc.revenue += fin.revenue;
        acc.costs += fin.costs;
        acc.profit += fin.profit;
        return acc;
      }, { revenue: 0, costs: 0, profit: 0 });
      $("fleetKpiBox").innerHTML = `
        <div class="card kpi col-4"><span>Receita da frota</span><strong>${money(totals.revenue)}</strong></div>
        <div class="card kpi col-4"><span>Custo da frota</span><strong>${money(totals.costs)}</strong></div>
        <div class="card kpi col-4"><span>Lucro da frota</span><strong>${money(totals.profit)}</strong></div>`;
    }
    $("fleetTable").innerHTML = rows.length ? `<table><thead><tr><th>Placa</th><th>Status</th><th>Tracker/KM</th><th>Receita</th><th>Custo</th><th>Lucro</th><th>Ações</th></tr></thead><tbody>` + rows.map((v) => {
      const fin = vehicleFinancials(v.id);
      return `<tr>
        <td><b>${esc(v.placa || v.id)}</b><br><span class="muted small">${esc(v.apelido || v.tipo || "")}</span></td>
        <td><span class="badge info">${esc(v.status || "")}</span></td>
        <td>${v.location ? `${esc(v.location.lat)}, ${esc(v.location.lng)}` : "Sem posição"}<br><span class="muted small">KM: ${esc(v.kmAtual || "-")}</span></td>
        <td><b>${money(fin.revenue)}</b><br><span class="muted small">${fin.calls} chamados</span></td>
        <td><b>${money(fin.costs)}</b><br><span class="muted small">${fin.maintenance} manutenções</span></td>
        <td><b>${money(fin.profit)}</b><br><span class="muted small">${marginPercent(fin.revenue, fin.profit)}</span></td>
        <td class="row-actions"><button class="btn" onclick="JM.app.editVehicle('${esc(v.id)}')">Editar</button>${canManageFleet() ? `<button class="btn danger" onclick="JM.app.deleteVehicle('${esc(v.id)}')">Excluir</button>` : ""}</td>
      </tr>`;
    }).join("") + `</tbody></table>` : `<p class="muted">Nenhum veículo.</p>`;

    $("vehicleCards").innerHTML = rows.length ? rows.map((v) => {
      const fin = vehicleFinancials(v.id);
      return `<div class="card col-3"><b>${esc(v.placa || v.id)}</b><p class="muted small">${esc(v.apelido || v.tipo || "")}</p><span class="badge info">${esc(v.status || "")}</span><p class="small">${v.location ? `Lat ${esc(v.location.lat)}<br>Lng ${esc(v.location.lng)}` : "Sem posição do tracker"}</p><p class="small"><b>Lucro:</b> ${money(fin.profit)}</p></div>`;
    }).join("") : `<p class="muted">Sem frota cadastrada.</p>`;

    renderMaintenance();
  }

  function renderMaintenance() {
    const rows = Object.values(state.maintenance || {}).sort((a, b) => String(b.date || b.createdAt || "").localeCompare(String(a.date || a.createdAt || "")));
    const box = $("maintenanceTable");
    if (!box) return;
    box.innerHTML = rows.length ? `<table><thead><tr><th>Data</th><th>Veículo</th><th>Tipo</th><th>Fornecedor</th><th>Valor</th><th>Status</th><th>Ações</th></tr></thead><tbody>` + rows.map((m) => `<tr>
      <td>${esc(m.date || dateTime(m.createdAt))}<br><span class="muted small">KM ${esc(m.km || "-")}</span></td>
      <td>${esc(vehicleLabel(m.vehicleId))}</td>
      <td>${esc(m.type || "")}</td>
      <td>${esc(m.supplier || "-")}<br><span class="muted small">Próx.: ${esc(m.nextReview || "-")}</span></td>
      <td><b>${money(m.amount || 0)}</b></td>
      <td><span class="badge info">${esc(m.status || "")}</span></td>
      <td class="row-actions"><button class="btn" onclick="JM.app.editMaintenance('${esc(m.id)}')">Editar</button><button class="btn danger" onclick="JM.app.deleteMaintenance('${esc(m.id)}')">Excluir</button></td>
    </tr>`).join("") + `</tbody></table>` : `<p class="muted">Nenhuma manutenção registrada.</p>`;
  }

  function editVehicle(id) {
    if (!canManageFleet()) return toast("Somente gestor/gerente pode editar frota.", "danger");
    const v = state.vehicles[id];
    if (!v) return toast("Veículo não encontrado.", "danger");
    showView("frota");
    setValue("vehiclePlate", v.placa || id);
    setValue("vehicleAlias", v.apelido || "");
    setValue("vehicleType", v.tipo || "");
    setValue("vehicleStatus", v.status || "Disponível");
    setValue("vehicleKm", v.kmAtual || "");
    setValue("vehicleFixedCost", v.fixedMonthlyCost || "");
    toast("Veículo carregado para edição.", "ok");
  }

  async function deleteVehicle(id) {
    if (!canManageFleet()) return toast("Somente gestor/gerente pode excluir veículo.", "danger");
    const v = state.vehicles[id];
    if (!v) return toast("Veículo não encontrado.", "danger");
    if (Object.values(state.calls).some((c) => c.vehicleId === id && !["Finalizado", "Cancelado"].includes(c.status))) {
      return toast("Não exclua veículo com chamado ativo. Coloque como Indisponível ou finalize/cancele os chamados.", "danger");
    }
    const motivo = window.prompt("Motivo para excluir veículo da frota:", "Baixa/remoção autorizada pelo gestor") || "Baixa/remoção autorizada pelo gestor";
    if (!window.confirm(`Excluir o veículo ${v.placa || id}? A auditoria será gravada.`)) return;
    await writeAudit("delete", "vehicles", id, v, { motivo });
    await db.collection("vehicles").doc(id).delete();
    toast("Veículo excluído com auditoria.", "ok");
  }

  $("vehicleForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!canManageFleet()) return toast("Somente gestor/gerente pode editar frota.", "danger");
    const placa = plateKey($("vehiclePlate").value);
    if (!placa) return toast("Informe a placa.", "danger");
    await db.collection("vehicles").doc(placa).set({
      placa,
      apelido: $("vehicleAlias").value.trim(),
      tipo: $("vehicleType").value.trim(),
      status: $("vehicleStatus").value,
      kmAtual: $("vehicleKm") ? $("vehicleKm").value.trim() : "",
      fixedMonthlyCost: $("vehicleFixedCost") ? parseMoney($("vehicleFixedCost").value) : 0,
      updatedAt: new Date().toISOString(),
      updatedBy: state.user.uid
    }, { merge: true });
    e.target.reset();
    toast("Veículo salvo.", "ok");
  };

  function maintenancePayloadFromForm() {
    return {
      vehicleId: $("maintVehicle").value,
      type: $("maintType").value,
      date: $("maintDate").value || todayInput(),
      km: $("maintKm").value.trim(),
      amount: parseMoney($("maintAmount").value),
      status: $("maintStatus").value,
      supplier: $("maintSupplier").value.trim(),
      nextReview: $("maintNext").value.trim(),
      notes: $("maintNotes").value.trim(),
      updatedAt: new Date().toISOString(),
      updatedBy: state.user.uid
    };
  }

  $("maintenanceForm") && ($("maintenanceForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!canManageFleet()) return toast("Somente gestor/gerente pode lançar manutenção.", "danger");
    const data = maintenancePayloadFromForm();
    if (!data.vehicleId) return toast("Selecione o veículo.", "danger");
    if (!data.amount) return toast("Informe o valor da manutenção.", "danger");
    const existingId = state.editingMaintenanceId;
    let maintenanceId = existingId;
    if (existingId) {
      await db.collection("maintenance").doc(existingId).set(data, { merge: true });
      const old = state.maintenance[existingId] || {};
      if (old.transactionId) {
        await db.collection("transactions").doc(old.transactionId).set({
          type: "saida",
          date: data.date,
          competenceDate: data.date,
          description: `Manutenção ${data.type} - ${vehicleLabel(data.vehicleId)}`,
          category: "Manutenção",
          costCenter: "Frota",
          party: data.supplier,
          grossAmount: data.amount,
          amount: data.amount,
          netAmount: data.amount,
          status: data.status === "Realizada" ? "Pago" : "Pendente",
          vehicleId: data.vehicleId,
          maintenanceId: existingId,
          notes: data.notes,
          updatedAt: new Date().toISOString(),
          updatedBy: state.user.uid
        }, { merge: true });
      }
    } else {
      const maintRef = await db.collection("maintenance").add(Object.assign({}, data, { createdAt: new Date().toISOString(), createdBy: state.user.uid }));
      maintenanceId = maintRef.id;
      const txRef = await db.collection("transactions").add({
        type: "saida",
        date: data.date,
        competenceDate: data.date,
        description: `Manutenção ${data.type} - ${vehicleLabel(data.vehicleId)}`,
        category: "Manutenção",
        costCenter: "Frota",
        party: data.supplier,
        grossAmount: data.amount,
        amount: data.amount,
        netAmount: data.amount,
        status: data.status === "Realizada" ? "Pago" : "Pendente",
        vehicleId: data.vehicleId,
        maintenanceId,
        notes: data.notes,
        createdAt: new Date().toISOString(),
        createdBy: state.user.uid
      });
      await maintRef.set({ transactionId: txRef.id }, { merge: true });
    }
    resetMaintenanceForm();
    toast("Manutenção salva e custo vinculado à frota.", "ok");
  });

  function editMaintenance(id) {
    if (!canManageFleet()) return toast("Somente gestor/gerente pode editar manutenção.", "danger");
    const m = state.maintenance[id];
    if (!m) return toast("Manutenção não encontrada.", "danger");
    state.editingMaintenanceId = id;
    showView("frota");
    setValue("maintVehicle", m.vehicleId || "");
    setValue("maintType", m.type || "Preventiva");
    setValue("maintDate", m.date || todayInput());
    setValue("maintKm", m.km || "");
    setValue("maintAmount", m.amount || "");
    setValue("maintStatus", m.status || "Realizada");
    setValue("maintSupplier", m.supplier || "");
    setValue("maintNext", m.nextReview || "");
    setValue("maintNotes", m.notes || "");
    setSubmitText("maintenanceForm", "Salvar alterações da manutenção");
    if ($("maintCancelEdit")) $("maintCancelEdit").classList.remove("hidden");
    toast("Manutenção carregada para edição.", "ok");
  }

  async function deleteMaintenance(id) {
    if (!canManageFleet()) return toast("Somente gestor/gerente pode excluir manutenção.", "danger");
    const m = state.maintenance[id];
    if (!m) return toast("Manutenção não encontrada.", "danger");
    const motivo = window.prompt("Motivo para excluir manutenção:", "Exclusão autorizada pelo gestor") || "Exclusão autorizada pelo gestor";
    if (!window.confirm("Excluir esta manutenção e o custo financeiro vinculado?")) return;
    await writeAudit("delete", "maintenance", id, m, { motivo });
    const batch = db.batch();
    batch.delete(db.collection("maintenance").doc(id));
    if (m.transactionId) batch.delete(db.collection("transactions").doc(m.transactionId));
    await batch.commit();
    if (state.editingMaintenanceId === id) resetMaintenanceForm();
    toast("Manutenção excluída com auditoria.", "ok");
  }

  function renderTeam() {
    const rows = Object.values(state.users).sort((a, b) => String(a.nome || a.email || "").localeCompare(String(b.nome || b.email || "")));
    $("teamTable").innerHTML = rows.length ? `<table><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Status</th><th>Ações</th></tr></thead><tbody>` +
      rows.map((u) => {
        const canDelete = u.id !== state.user?.uid;
        const deleteButton = canDelete ? `<button class="btn danger" onclick="JM.app.deleteTeamMember('${esc(u.id)}')">Excluir</button>` : "";
        return `<tr><td><b>${esc(u.nome || "")}</b><br><span class="muted small">${esc(u.uid || u.id)}</span></td><td>${esc(u.email || "")}</td><td><span class="badge info">${esc(roleLabel(u.role))}</span></td><td>${u.active === false ? "Inativo" : "Ativo"}</td><td class="row-actions"><button class="btn" onclick="JM.app.editTeamMember('${esc(u.id)}')">Editar</button>${deleteButton}</td></tr>`;
      }).join("") +
      `</tbody></table>` : `<p class="muted">Nenhum usuário.</p>`;
  }

  function roleLabel(role) {
    const labels = {
      owner: "Dono/Gestor master",
      admin: "Gestor/Admin",
      gestor: "Gestor",
      gerente: "Gerente",
      auxiliar: "Auxiliar",
      atendente: "Atendente",
      finance: "Financeiro",
      driver: "Motorista",
      motorista: "Motorista"
    };
    return labels[normalizedRole(role)] || role || "Equipe";
  }

  function roleCanAccessJM(role) {
    return OFFICE_ROLES.includes(normalizedRole(role));
  }

  function editTeamMember(id) {
    if (!isAdmin()) return toast("Somente gestor/dono pode editar funcionários.", "danger");
    const user = state.users[id];
    if (!user) return toast("Funcionário não encontrado.", "danger");
    state.editingUserId = id;
    showView("equipe");
    setValue("teamName", user.nome || "");
    setValue("teamEmail", user.email || "");
    setValue("teamRole", normalizedRole(user.role) === "motorista" ? "driver" : normalizedRole(user.role || "driver"));
    setValue("teamActive", user.active === false ? "false" : "true");
    setValue("teamPass", "");
    if ($("teamEmail")) $("teamEmail").readOnly = true;
    if ($("teamPass")) $("teamPass").placeholder = "deixe em branco para manter";
    setSubmitText("teamForm", "Salvar alterações do funcionário");
    if ($("teamCancelEdit")) $("teamCancelEdit").classList.remove("hidden");
    toast("Edite o funcionário e salve as alterações.", "ok");
  }

  async function deleteTeamMember(id) {
    if (!isAdmin()) return toast("Somente gestor/dono pode excluir funcionários.", "danger");
    if (id === state.user?.uid) return toast("Você não pode excluir o próprio usuário logado.", "danger");
    const user = state.users[id];
    if (!user) return toast("Funcionário não encontrado.", "danger");
    const email = String(user.email || "").toLowerCase().trim();
    if (!window.confirm(`Excluir ${user.nome || email || "este funcionário"} do painel JM? O login no Firebase Auth deve ser removido pelo Console ou por uma Cloud Function.`)) return;
    const batch = db.batch();
    batch.delete(db.collection("users").doc(id));
    if (email) {
      batch.delete(db.collection("managerAccess").doc(email));
      batch.delete(db.collection("driverAccess").doc(email));
    }
    await batch.commit();
    if (state.editingUserId === id) resetTeamForm();
    toast("Funcionário removido do painel.", "ok");
  }

  $("teamForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!isAdmin()) return toast("Somente gestor/gerente pode editar equipe.", "danger");
    const email = $("teamEmail").value.trim().toLowerCase();
    const pass = $("teamPass").value;
    const selectedRole = normalizedRole($("teamRole").value || "driver");
    const isDriverRole = DRIVER_ROLES.includes(selectedRole);
    const isOfficeRole = roleCanAccessJM(selectedRole);
    const editingId = state.editingUserId;

    if (!isDriverRole && !isOfficeRole) return toast("Perfil inválido.", "danger");
    if (isDriverRole && await emailReservedForManager(email)) {
      return toast("Este e-mail está liberado como gestor/equipe interna. Ele não pode ser salvo como motorista.", "danger");
    }
    if (!editingId && !pass) return toast("Informe uma senha inicial para criar o usuário no Firebase Auth.", "danger");
    if (editingId && pass) return toast("Senha de usuário existente deve ser redefinida no Firebase Authentication.", "danger");

    let uid = editingId || uidSafe(email);
    if (pass) {
      if (pass.length < 6) return toast("Informe uma senha inicial com pelo menos 6 caracteres.", "danger");
      try {
        const cred = await secondaryAuth.createUserWithEmailAndPassword(email, pass);
        uid = cred.user.uid;
        await secondaryAuth.signOut().catch(() => {});
      } catch (err) {
        if (err && err.code === "auth/email-already-in-use") {
          // Para gestor/gerente/atendente, o jm.html repara users/{uid} no primeiro login usando managerAccess/{email}.
          // Para motorista, o painel motorista tambem procura por e-mail e repara o UID quando possivel.
          uid = uidSafe(email);
        } else {
          return toast(friendlyAuthError(err), "danger");
        }
      }
    }

    const payload = {
      uid,
      nome: $("teamName").value.trim(),
      email,
      role: selectedRole,
      active: $("teamActive").value === "true",
      updatedAt: new Date().toISOString(),
      updatedBy: state.user.uid,
      source: "jm-teamForm"
    };

    await db.collection("users").doc(uid).set(payload, { merge: true });
    const accessPayload = Object.assign({ createdAt: new Date().toISOString() }, payload);
    if (isOfficeRole) {
      await db.collection("managerAccess").doc(email).set(accessPayload, { merge: true });
      await db.collection("driverAccess").doc(email).delete().catch(() => {});
    }
    if (isDriverRole) {
      try {
        await db.collection("driverAccess").doc(email).set(accessPayload, { merge: true });
        await db.collection("managerAccess").doc(email).delete().catch(() => {});
      } catch (err) {
        toast("Motorista salvo, mas driverAccess foi bloqueado. Publique as novas firestore.rules para liberar o primeiro login.", "danger");
        return;
      }
    }
    resetTeamForm();
    toast(roleLabel(selectedRole) + " salvo na equipe.", "ok");
  };

  function renderDriverPanel() {
    const myCalls = Object.values(state.calls).filter((c) => isAdmin() || c.driverId === state.user?.uid);
    $("driverCalls").innerHTML = myCalls.length ? myCalls.map((c) => {
      const route = callRoutePoints(c);
      return `<div class="card" style="margin-bottom:12px"><div class="actions"><div><b>${esc(c.protocolo || c.cliente)}</b><br><span class="muted small">${esc(c.originLabel || "")} → ${esc(c.destLabel || "")}</span></div><span class="badge ${statusClass(c.status)}">${esc(c.status || "")}</span></div><p>${esc(c.notes || "")}</p><p><b>${routeKm(c)} km</b></p>${route.origin && route.destination ? `<a class="btn primary" target="_blank" href="https://www.google.com/maps/dir/${route.origin.lat},${route.origin.lng}/${route.destination.lat},${route.destination.lng}">Abrir rota</a>` : ""}</div>`;
    }).join("") : `<p class="muted">Nenhum chamado.</p>`;
  }

  $("expenseForm") && ($("expenseForm").onsubmit = async (e) => {
    e.preventDefault();
    const data = {
      callId: $("expenseCall").value,
      vehicleId: $("expenseVehicle").value,
      type: $("expenseType").value,
      amount: parseMoney($("expenseAmount").value),
      notes: $("expenseNotes").value.trim(),
      status: "pendente",
      driverId: state.user.uid,
      driverName: state.profile.nome || state.user.email,
      createdAt: new Date().toISOString()
    };
    await db.collection("expenses").add(data);
    e.target.reset();
    toast("Despesa enviada para aprovação.", "ok");
  });

  function financeKpiBy(field) {
    const groups = {};
    filteredTransactions().forEach((t) => {
      const key = t[field] || "sem_vinculo";
      groups[key] = groups[key] || { id: key, revenue: 0, costs: 0, calls: 0 };
      if (t.type === "entrada") groups[key].revenue += Math.abs(transactionAmount(t));
      if (t.type === "saida") groups[key].costs += Math.abs(transactionAmount(t));
    });
    Object.values(state.calls).forEach((c) => {
      const key = c[field] || "sem_vinculo";
      groups[key] = groups[key] || { id: key, revenue: 0, costs: 0, calls: 0 };
      groups[key].calls += 1;
    });
    return Object.values(groups).map((g) => ({ ...g, profit: g.revenue - g.costs })).sort((a, b) => b.profit - a.profit).slice(0, 12);
  }

  function renderFinanceKpis() {
    const box = $("financeKpiTables");
    if (!box) return;
    const vehicles = financeKpiBy("vehicleId");
    const drivers = financeKpiBy("driverId");
    const table = (title, rows, labelFn) => `<div class="card col-6"><h3>${esc(title)}</h3><div class="table-wrap mini-table"><table><thead><tr><th>Nome</th><th>Receita</th><th>Custo</th><th>Lucro</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(labelFn(r.id))}</td><td>${money(r.revenue)}</td><td>${money(r.costs)}</td><td><b>${money(r.profit)}</b></td></tr>`).join("") || `<tr><td colspan="4" class="muted">Sem dados.</td></tr>`}</tbody></table></div></div>`;
    box.innerHTML = table("Por veículo", vehicles, vehicleLabel) + table("Por motorista", drivers, driverLabel);
  }

  function renderFinance() {
    if (!$("financeTable")) return;
    const rows = filteredTransactions().sort((a, b) => String(b.date || b.createdAt || "").localeCompare(String(a.date || a.createdAt || "")));
    const summary = financialSummary(rows);
    const profit = summary.revenue - summary.costs + summary.adjustments;
    if ($("finKpiRevenue")) $("finKpiRevenue").textContent = money(summary.revenue);
    if ($("finKpiCosts")) $("finKpiCosts").textContent = money(summary.costs);
    if ($("finKpiProfit")) $("finKpiProfit").textContent = money(profit);
    if ($("finKpiMargin")) $("finKpiMargin").textContent = marginPercent(summary.revenue, profit);
    $("financeTable").innerHTML = rows.length ? `<table><thead><tr><th>Data</th><th>Tipo/Categoria</th><th>Descrição</th><th>Vínculos</th><th>Status</th><th>Valor</th><th>Ações</th></tr></thead><tbody>` +
      rows.map((t) => `<tr>
        <td>${esc(t.date || dateTime(t.createdAt))}<br><span class="muted small">Venc.: ${esc(t.dueDate || "-")}</span></td>
        <td><span class="badge ${t.type === "entrada" ? "ok" : t.type === "saida" ? "danger" : "info"}">${esc(t.type || "")}</span><br><span class="muted small">${esc(t.category || "-")} · ${esc(t.costCenter || "-")}</span></td>
        <td><b>${esc(t.description || "")}</b><br><span class="muted small">${esc(t.party || "")} ${t.notes ? " · " + esc(t.notes) : ""}</span></td>
        <td><span class="small">Chamado: ${esc(callLabel(t.callId))}</span><br><span class="small">Veículo: ${esc(vehicleLabel(t.vehicleId))}</span><br><span class="small">Motorista: ${esc(driverLabel(t.driverId))}</span></td>
        <td>${esc(t.status || "")}</td>
        <td><b>${money(transactionAmount(t))}</b></td>
        <td class="row-actions"><button class="btn" onclick="JM.app.editTransaction('${esc(t.id)}')">Editar</button>${canDeleteFinancial() ? `<button class="btn danger" onclick="JM.app.deleteTransaction('${esc(t.id)}')">Excluir</button>` : ""}</td>
      </tr>`).join("") + `</tbody></table>${reportSignature()}` : `<p class="muted">Nenhum lançamento no filtro atual.</p>${reportSignature()}`;

    const pending = Object.values(state.expenses).filter((e) => e.status === "pendente");
    $("expenseApproval").innerHTML = pending.length ? `<table><thead><tr><th>Motorista</th><th>Tipo</th><th>Chamado/Veículo</th><th>Valor</th><th>Obs</th><th>Ações</th></tr></thead><tbody>` +
      pending.map((e) => `<tr>
        <td>${esc(e.driverName || driverLabel(e.driverId))}</td><td>${esc(e.type || "")}</td><td>${esc(callLabel(e.callId))}<br><span class="muted small">${esc(vehicleLabel(e.vehicleId))}</span></td><td><b>${money(e.amount || 0)}</b></td>
        <td>${esc(e.notes || "")}${e.photoUrl ? `<br><a class="info" href="${esc(e.photoUrl)}" target="_blank">Comprovante</a>` : ""}</td>
        <td class="row-actions"><button class="btn good" onclick="JM.app.approveExpense('${esc(e.id)}')">Aprovar</button><button class="btn danger" onclick="JM.app.rejectExpense('${esc(e.id)}')">Reprovar</button></td>
      </tr>`).join("") + `</tbody></table>` : `<p class="muted">Nenhuma despesa pendente.</p>`;
    renderFinanceKpis();
  }

  $("financeForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!canEditFinancial()) return toast("Somente gestor/gerente/financeiro pode lançar.", "danger");
    const payload = transactionPayloadFromForm();
    if (!payload.description) return toast("Informe a descrição.", "danger");
    if (!payload.amount) return toast("Informe o valor.", "danger");
    const editingId = state.editingTransactionId;
    if (editingId) {
      await db.collection("transactions").doc(editingId).set(payload, { merge: true });
      toast("Lançamento financeiro atualizado.", "ok");
    } else {
      await db.collection("transactions").add(Object.assign({}, payload, { createdAt: new Date().toISOString(), createdBy: state.user.uid }));
      toast("Lançamento financeiro salvo.", "ok");
    }
    resetFinanceForm();
  };

  function editTransaction(id) {
    if (!canEditFinancial()) return toast("Sem permissão para editar financeiro.", "danger");
    const t = state.transactions[id];
    if (!t) return toast("Lançamento não encontrado.", "danger");
    state.editingTransactionId = id;
    showView("financeiro");
    setValue("finType", t.type || "entrada");
    setValue("finStatus", t.status || "Pendente");
    setValue("finDate", t.date || t.competenceDate || todayInput());
    setValue("finDueDate", t.dueDate || "");
    setValue("finPaidDate", t.paidDate || "");
    setValue("finCategory", t.category || "Outros");
    setValue("finCostCenter", t.costCenter || "Operacional");
    setValue("finVehicle", t.vehicleId || "");
    setValue("finDriver", t.driverId || "");
    setValue("finCall", t.callId || "");
    setValue("finParty", t.party || "");
    setValue("finAmount", t.grossAmount != null ? t.grossAmount : t.amount || "");
    setValue("finDiscount", t.discount || "");
    setValue("finExtra", t.extra || "");
    setValue("finPaymentMethod", t.paymentMethod || "Pix");
    setValue("finDesc", t.description || "");
    setValue("finNotes", t.notes || "");
    setSubmitText("financeForm", "Salvar alterações financeiras");
    if ($("finCancelEdit")) $("finCancelEdit").classList.remove("hidden");
    toast("Lançamento carregado para edição.", "ok");
  }

  async function deleteTransaction(id) {
    if (!canDeleteFinancial()) return toast("Somente gestor/dono pode excluir financeiro.", "danger");
    const t = state.transactions[id];
    if (!t) return toast("Lançamento não encontrado.", "danger");
    const motivo = window.prompt("Motivo obrigatório da exclusão financeira:", "Exclusão autorizada pelo gestor") || "Exclusão autorizada pelo gestor";
    if (!window.confirm("Excluir definitivamente este lançamento? A cópia ficará em auditLogs.")) return;
    await writeAudit("delete", "transactions", id, t, { motivo });
    await db.collection("transactions").doc(id).delete();
    if (state.editingTransactionId === id) resetFinanceForm();
    toast("Lançamento excluído com auditoria.", "ok");
  }

  async function approveExpense(id) {
    const expense = state.expenses[id];
    if (!expense || !canApproveExpense()) return;
    await db.collection("expenses").doc(id).update({ status: "aprovado", approvedAt: new Date().toISOString(), approvedBy: state.user.uid });
    const value = Number(expense.amount || 0);
    await db.collection("transactions").add({
      type: "saida",
      date: todayInput(),
      competenceDate: todayInput(),
      description: `Despesa ${expense.type || ""} - ${expense.driverName || ""}`,
      category: expense.type || "Despesa operacional",
      costCenter: "Operacional",
      grossAmount: value,
      amount: value,
      netAmount: value,
      status: "Pendente",
      expenseId: id,
      callId: expense.callId || "",
      vehicleId: expense.vehicleId || "",
      driverId: expense.driverId || "",
      party: expense.driverName || "",
      notes: expense.notes || "",
      createdAt: new Date().toISOString(),
      createdBy: state.user.uid
    });
    toast("Despesa aprovada e lançada no financeiro.", "ok");
  }

  async function rejectExpense(id) {
    if (!canApproveExpense()) return;
    const expense = state.expenses[id] || {};
    await writeAudit("reject", "expenses", id, expense, { motivo: "Despesa reprovada" });
    await db.collection("expenses").doc(id).update({ status: "reprovado", rejectedAt: new Date().toISOString(), rejectedBy: state.user.uid });
    toast("Despesa reprovada.", "ok");
  }

  function exportFinanceCsv() {
    const rows = filteredTransactions().map((t) => ({
      Data: t.date || "",
      Tipo: t.type || "",
      Categoria: t.category || "",
      Centro: t.costCenter || "",
      Descricao: t.description || "",
      Status: t.status || "",
      Valor: transactionAmount(t),
      Chamado: callLabel(t.callId),
      Veiculo: vehicleLabel(t.vehicleId),
      Motorista: driverLabel(t.driverId),
      Pessoa: t.party || ""
    }));
    downloadCsv("jm-financeiro.csv", ["Data", "Tipo", "Categoria", "Centro", "Descricao", "Status", "Valor", "Chamado", "Veiculo", "Motorista", "Pessoa"], rows);
  }

  function refreshMaps() {
    const active = document.querySelector(".view.active");
    if (!active) return;
    if (active.id === "view-dashboard") window.JM.mapa.renderFleetMap("dashboardMap", state.vehicles, state.calls);
    if (active.id === "view-mapa") window.JM.mapa.renderFleetMap("fleetMap", state.vehicles, state.calls);
  }

  function registerFreshServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("service-worker.js?v=" + LOGIN_FLOW_VERSION).catch(() => {});
  }

  function bindRouteButtons() {
    if ($("btnGeocodeOrigin")) $("btnGeocodeOrigin").onclick = () => geocodeAddress("origin");
    if ($("btnGeocodeDest")) $("btnGeocodeDest").onclick = () => geocodeAddress("destination");
    if ($("btnUseCurrentLocation")) $("btnUseCurrentLocation").onclick = useCurrentLocationAsOrigin;
    if ($("btnSmartRoute")) $("btnSmartRoute").onclick = calculateSmartRoute;
    if ($("btnOpenGoogleRoute")) $("btnOpenGoogleRoute").onclick = openGoogleRouteFromForm;
    if ($("btnSyncTrackerNow")) $("btnSyncTrackerNow").onclick = () => syncTrackerNow(true);
    if ($("callCancelEdit")) $("callCancelEdit").onclick = resetCallForm;
    if ($("teamCancelEdit")) $("teamCancelEdit").onclick = resetTeamForm;
    if ($("finCancelEdit")) $("finCancelEdit").onclick = resetFinanceForm;
    if ($("maintCancelEdit")) $("maintCancelEdit").onclick = resetMaintenanceForm;
    if ($("btnExportFinanceCsv")) $("btnExportFinanceCsv").onclick = exportFinanceCsv;
    ["finFilterFrom", "finFilterTo", "finFilterVehicle", "finFilterDriver", "finFilterType", "finFilterStatus"].forEach((id) => {
      if ($(id)) $(id).onchange = renderFinance;
    });
  }

  function boot() {
    bindNavigation();
    bindRouteButtons();
    renderSmartRouteBox();
    initializeAddressTools();
    if ($("finDate")) $("finDate").value = todayInput();
    if ($("maintDate")) $("maintDate").value = todayInput();
    const r = monthRange();
    if ($("finFilterFrom")) $("finFilterFrom").value = r.first;
    if ($("finFilterTo")) $("finFilterTo").value = r.last;
    console.info("JM Guinchos login flow", LOGIN_FLOW_VERSION);
    registerFreshServiceWorker();
  }

  window.JM = window.JM || {};
  window.JM.app = {
    setCallStatus,
    editCall,
    cancelCall,
    deleteCall,
    viewCallDre,
    editVehicle,
    deleteVehicle,
    editMaintenance,
    deleteMaintenance,
    editTeamMember,
    deleteTeamMember,
    editTransaction,
    deleteTransaction,
    approveExpense,
    rejectExpense,
    applySmartVehicle,
    calculateSmartRoute,
    syncTrackerNow,
    state
  };
  boot();
}());
