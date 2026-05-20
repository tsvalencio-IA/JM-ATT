(function () {
  "use strict";

  const { $, esc, money, parseMoney, dateTime, toast, statusClass, routeKm, mapsRouteUrl } = window.JM.utils;
  const { auth, db, arrayUnion } = window.JM.firebase;
  const cfg = window.JM_CONFIG || {};
  const DRIVER_FLOW_VERSION = "jm-financeiro-frota-kpi-v13";
  const state = { user: null, profile: null, calls: {}, vehicles: {}, expenses: {}, settings: {} };
  const unsubscribers = [];

  function friendlyAuthError(err) {
    const code = err && err.code || "";
    if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") return "Usuário ou senha inválidos.";
    return "Acesso negado: " + (err && err.message || "falha de autenticação");
  }

  function stopListeners() {
    unsubscribers.splice(0).forEach((fn) => fn());
  }

  function normalizedRole(role) {
    return String(role || "").toLowerCase().trim();
  }

  function isDriverRole(role) {
    return ["driver", "motorista"].includes(normalizedRole(role));
  }

  function normalizeDriverProfile(user, data) {
    const profile = Object.assign({}, data || {}, {
      uid: user.uid,
      email: String(user.email || "").toLowerCase(),
      role: normalizedRole(data && data.role || "driver") || "driver",
      active: data && data.active !== false
    });
    if (!isDriverRole(profile.role)) {
      throw new Error("Este login existe, mas nao esta marcado como motorista.");
    }
    if (profile.active === false) {
      throw new Error("Seu usuario nao esta ativo no cadastro da JM Guinchos.");
    }
    return profile;
  }

  async function repairDriverFromAccess(user) {
    const email = String(user.email || "").toLowerCase().trim();
    if (!email) return null;
    const permitSnap = await db.collection("driverAccess").doc(email).get();
    if (!permitSnap.exists) return null;
    const permit = permitSnap.data() || {};
    const profile = normalizeDriverProfile(user, {
      nome: permit.nome || user.displayName || email.split("@")[0],
      role: permit.role || "driver",
      active: permit.active !== false,
      source: "motorista-driverAccessRepair"
    });
    const payload = Object.assign({}, permit, profile, {
      repairedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await db.collection("users").doc(user.uid).set(payload, { merge: true });
    return { id: user.uid, ...payload };
  }

  async function loadProfile(user) {
    const ref = db.collection("users").doc(user.uid);
    const snap = await ref.get();
    if (snap.exists) {
      return { id: user.uid, ...normalizeDriverProfile(user, snap.data()) };
    }

    const repairedByAccess = await repairDriverFromAccess(user);
    if (repairedByAccess) {
      return repairedByAccess;
    }

    // Reparo para e-mail criado no Auth antes de existir users/{uid}.
    const byEmail = await db.collection("users").where("email", "==", String(user.email || "").toLowerCase().trim()).limit(1).get();
    if (!byEmail.empty) {
      const doc = byEmail.docs[0];
      const data = normalizeDriverProfile(user, doc.data() || {});
      const repaired = Object.assign({}, data, {
        uid: user.uid,
        email: user.email,
        repairedUidAt: new Date().toISOString()
      });
      await ref.set(repaired, { merge: true });
      return { id: user.uid, ...repaired };
    }
    throw new Error("Seu motorista existe no Auth, mas nao esta liberado em driverAccess. Recrie/atualize o motorista no jm.html depois de publicar as regras novas.");
  }

  function startListeners() {
    stopListeners();
    unsubscribers.push(db.collection("vehicles").onSnapshot((snap) => {
      const rows = {};
      snap.forEach((doc) => { rows[doc.id] = { id: doc.id, ...doc.data() }; });
      state.vehicles = rows;
      render();
    }));
    unsubscribers.push(db.collection("calls").where("driverId", "==", state.user.uid).onSnapshot((snap) => {
      const rows = {};
      snap.forEach((doc) => { rows[doc.id] = { id: doc.id, ...doc.data() }; });
      state.calls = rows;
      render();
    }));
    unsubscribers.push(db.collection("expenses").where("driverId", "==", state.user.uid).onSnapshot((snap) => {
      const rows = {};
      snap.forEach((doc) => { rows[doc.id] = { id: doc.id, ...doc.data() }; });
      state.expenses = rows;
      render();
    }));
  }

  auth.onAuthStateChanged(async (user) => {
    stopListeners();
    state.user = user || null;
    if (!user) {
      $("driverLoginView").classList.remove("hidden");
      $("driverAppView").classList.add("hidden");
      return;
    }
    try {
      state.profile = await loadProfile(user);
      $("driverLoginView").classList.add("hidden");
      $("driverAppView").classList.remove("hidden");
      $("driverUserBox").textContent = `${state.profile.nome || user.email} - ${state.profile.role || "motorista"}`;
      startListeners();
    } catch (err) {
      $("driverLoginError").textContent = err.message;
      await auth.signOut();
    }
  });

  $("driverLoginForm").onsubmit = async (e) => {
    e.preventDefault();
    $("driverLoginError").textContent = "";
    try {
      await auth.signInWithEmailAndPassword($("driverLoginEmail").value.trim(), $("driverLoginPass").value);
    } catch (err) {
      $("driverLoginError").textContent = friendlyAuthError(err);
    }
  };

  $("driverLogoutBtn").onclick = () => auth.signOut();
  $("driverRefreshBtn").onclick = () => render();

  function activeCalls() {
    return Object.values(state.calls).filter((c) => !["Finalizado", "Cancelado"].includes(c.status));
  }

  function render() {
    renderDriverKpis();
    renderCalls();
    renderExpenseSelects();
    window.JM.mapa.renderFleetMap("driverMap", state.vehicles, state.calls);
  }

  function renderDriverKpis() {
    const calls = Object.values(state.calls);
    const finalizados = calls.filter((c) => c.status === "Finalizado");
    const ativos = calls.filter((c) => !["Finalizado", "Cancelado"].includes(c.status));
    const receita = calls.reduce((sum, c) => sum + Number(c.valor || 0), 0);
    const despesas = Object.values(state.expenses).filter((e) => e.status !== "reprovado").reduce((sum, e) => sum + Number(e.amount || 0), 0);
    if ($("driverKpiBox")) $("driverKpiBox").innerHTML = `
      <div class="card kpi col-3"><span>Ativos</span><strong>${ativos.length}</strong></div>
      <div class="card kpi col-3"><span>Finalizados</span><strong>${finalizados.length}</strong></div>
      <div class="card kpi col-3"><span>Valor vinculado</span><strong>${money(receita)}</strong></div>
      <div class="card kpi col-3"><span>Despesas lançadas</span><strong>${money(despesas)}</strong></div>`;
  }

  function renderCalls() {
    const calls = Object.values(state.calls).sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
    $("driverCallsBox").innerHTML = calls.length ? calls.map((call) => {
      const vehicle = state.vehicles[call.vehicleId] || {};
      const url = call.routeUrl || mapsRouteUrl(call, vehicle);
      const km = routeKm(call, vehicle);
      return `<div class="card" style="margin-bottom:10px">
        <div class="actions" style="justify-content:space-between">
          <div><b>${esc(call.protocolo || call.id)}</b><br><span class="muted small">${esc(call.cliente || "")} - ${esc(vehicle.placa || "")}</span></div>
          <span class="badge ${statusClass(call.status)}">${esc(call.status || "Novo")}</span>
        </div>
        <p class="small"><b>Origem:</b> ${esc(call.origem?.label || call.originLabel || "-")}<br><b>Destino:</b> ${esc(call.destino?.label || call.destLabel || "-")}<br><b>Rota:</b> ${km ? km.toFixed(1).replace(".", ",") + " km estimados" : "aguardando coordenadas"}<br><b>Valor previsto:</b> ${money(call.valor || 0)}</p>
        <div class="actions">
          ${url ? `<a class="btn good" target="_blank" href="${esc(url)}">Abrir rota no Maps</a>` : ""}
          <button class="btn primary" onclick="JM.motorista.setStatus('${esc(call.id)}','Em Atendimento')">Iniciar</button>
          <button class="btn" onclick="JM.motorista.setStatus('${esc(call.id)}','Finalizado')">Finalizar</button>
        </div>
      </div>`;
    }).join("") + `<div class="report-signature">Powered by thIAguinho Soluções Digitais</div>` : `<p class="muted">Nenhum chamado vinculado ao seu usuário.</p>`;
  }

  function renderExpenseSelects() {
    $("driverExpenseCall").innerHTML = `<option value="">Sem chamado</option>` + activeCalls().map((c) => `<option value="${esc(c.id)}">${esc(c.protocolo || c.cliente)}</option>`).join("");
    $("driverExpenseVehicle").innerHTML = `<option value="">Selecione</option>` + Object.values(state.vehicles).map((v) => `<option value="${esc(v.id)}">${esc(v.placa || v.id)}</option>`).join("");
  }

  async function setStatus(id, status) {
    const call = state.calls[id];
    if (!call) return;
    await db.collection("calls").doc(id).update({
      status,
      updatedAt: Date.now(),
      timeline: arrayUnion({ at: new Date().toISOString(), by: state.profile.nome || state.user.email, text: "Motorista alterou status para " + status })
    });
    toast("Chamado atualizado.", "ok");
  }

  async function uploadToCloudinary(file) {
    const cloud = cfg.cloudinary || {};
    if (!file || !cloud.cloudName || !cloud.uploadPreset) return "";
    const form = new FormData();
    form.append("file", file);
    form.append("upload_preset", cloud.uploadPreset);
    form.append("folder", cloud.folder || "jm-guinchos");
    const response = await fetch(`https://api.cloudinary.com/v1_1/${cloud.cloudName}/upload`, { method: "POST", body: form });
    if (!response.ok) throw new Error("Cloudinary recusou o upload.");
    const data = await response.json();
    return data.secure_url || "";
  }

  $("driverExpenseForm").onsubmit = async (e) => {
    e.preventDefault();
    const photo = $("driverExpensePhoto").files && $("driverExpensePhoto").files[0];
    let photoUrl = "";
    try { photoUrl = await uploadToCloudinary(photo); } catch (err) { toast("Foto não enviada: " + err.message, "danger"); }
    await db.collection("expenses").add({
      callId: $("driverExpenseCall").value,
      vehicleId: $("driverExpenseVehicle").value,
      type: $("driverExpenseType").value,
      amount: parseMoney($("driverExpenseAmount").value),
      notes: $("driverExpenseNotes").value.trim(),
      photoUrl,
      status: "pendente",
      driverId: state.user.uid,
      driverName: state.profile.nome || state.user.email,
      createdAt: new Date().toISOString(),
      createdBy: state.user.uid
    });
    e.target.reset();
    toast("Despesa enviada para aprovação.", "ok");
  };

  window.JM = window.JM || {};
  window.JM.motorista = { setStatus, state };
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js?v=" + DRIVER_FLOW_VERSION).catch(() => {});
}());
