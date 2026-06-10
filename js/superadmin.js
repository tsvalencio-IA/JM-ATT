(function () {
  "use strict";

  const { $, esc, toast } = window.JM.utils;
  const { auth, secondaryAuth, db, ts, emailIsSuperAdmin } = window.JM.firebase;
  const cfg = window.JM_CONFIG || {};
  let settings = {};
  let vehicles = {};
  let trackerProviders = {};



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

  function friendlyAuthError(err) {
    const code = err && err.code || "";
    if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") return "Usuário ou senha inválidos.";
    if (code === "auth/email-already-in-use") return "Este e-mail já existe no Firebase Auth.";
    if (code === "auth/operation-not-allowed") return "Ative E-mail/Senha no Firebase Authentication.";
    return err && err.message || "Falha de autenticação.";
  }

  async function ensureSuperProfile(user) {
    if (!emailIsSuperAdmin(user.email)) throw new Error("E-mail não liberado como superadmin em js/config.firebase.js.");
    const ref = db.collection("users").doc(user.uid);
    const snap = await ref.get();
    const profile = {
      uid: user.uid,
      email: user.email,
      nome: user.displayName || user.email.split("@")[0],
      role: "superadmin",
      active: true,
      updatedAt: ts()
    };
    await ref.set(snap.exists ? profile : Object.assign({ createdAt: ts() }, profile), { merge: true });
    return profile;
  }

  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      $("superLoginView").classList.remove("hidden");
      $("superAppView").classList.add("hidden");
      return;
    }
    try {
      await ensureSuperProfile(user);
      $("superLoginView").classList.add("hidden");
      $("superAppView").classList.remove("hidden");
      $("superUserBox").textContent = user.email;
      bindSettings();
    } catch (err) {
      $("superLoginError").textContent = err.message;
      await auth.signOut();
    }
  });

  $("superLoginForm").onsubmit = async (e) => {
    e.preventDefault();
    $("superLoginError").textContent = "";
    try {
      await auth.signInWithEmailAndPassword($("superEmail").value.trim(), $("superPass").value);
    } catch (err) {
      $("superLoginError").textContent = friendlyAuthError(err);
    }
  };

  $("superFirstAccessBtn").onclick = async () => {
    const email = $("superEmail").value.trim().toLowerCase();
    const pass = $("superPass").value;
    $("superLoginError").textContent = "";
    if (!emailIsSuperAdmin(email)) return $("superLoginError").textContent = "Este e-mail não está liberado como superadmin.";
    if (!pass || pass.length < 6) return $("superLoginError").textContent = "Senha mínima: 6 caracteres.";
    try {
      await auth.createUserWithEmailAndPassword(email, pass);
    } catch (err) {
      $("superLoginError").textContent = friendlyAuthError(err);
    }
  };

  $("superLogoutBtn").onclick = () => auth.signOut();
  $("superSeedBtn").onclick = () => seedBase();
  $("superSyncTrackerBtn").onclick = () => syncTracker();

  function bindSettings() {
    db.collection("settings").doc("integrations").onSnapshot((snap) => {
      settings = snap.exists ? snap.data() : {};
      renderSettings();
    });
    db.collection("settings").doc("company").onSnapshot((snap) => {
      const company = Object.assign({}, cfg.empresa || {}, snap.exists ? snap.data() : {});
      $("companyName").value = company.nome || "";
      $("companyCity").value = company.cidadeBase || "";
      $("companyPhone").value = company.telefoneOperacional || "";
    });
    db.collection("vehicles").onSnapshot((snap) => {
      vehicles = {};
      snap.forEach((doc) => { vehicles[doc.id] = { id: doc.id, ...doc.data() }; });
      renderTrackerProviders();
    });
    db.collection("trackerProviders").onSnapshot((snap) => {
      trackerProviders = {};
      snap.forEach((doc) => { trackerProviders[doc.id] = { id: doc.id, ...doc.data() }; });
      renderTrackerProviders();
    });
  }

  function renderSettings() {
    const tracker = mergeNonEmpty(cfg.tracker || {}, settings.tracker || {});
    const cloud = mergeNonEmpty(cfg.cloudinary || {}, settings.cloudinary || {});
    const googleMaps = mergeNonEmpty(mergeNonEmpty(cfg.map || {}, cfg.googleMaps || {}), mergeNonEmpty(settings.map || {}, settings.googleMaps || {}));
    const mobileGps = Object.assign({ enabled: false, backend: "realtime_database", databaseURL: "", pollingMs: 10000, minIntervalMs: 20000, minDistanceMeters: 25 }, mergeNonEmpty(cfg.mobileGps || {}, settings.mobileGps || {}));
    $("trackerPlatform").value = tracker.platformUrl || "";
    $("trackerEndpoint").value = tracker.endpoint || "";
    $("trackerToken").value = tracker.token || "";
    if ($("trackerSocket")) $("trackerSocket").value = tracker.socketUrl || "";
    $("trackerHeader").value = tracker.tokenHeader || "Authorization";
    $("trackerPrefix").value = tracker.tokenPrefix || "Bearer ";
    $("trackerPolling").value = tracker.pollingMs || 30000;
    $("trackerFha").value = tracker.vehicles && tracker.vehicles.FHA4B30 && tracker.vehicles.FHA4B30.trackerId || "FHA4B30";
    $("trackerDaj").value = tracker.vehicles && tracker.vehicles.DAJ6J95 && tracker.vehicles.DAJ6J95.trackerId || "DAJ6J95";
    $("superCloudName").value = cloud.cloudName || "";
    $("superCloudPreset").value = cloud.uploadPreset || "";
    $("superGoogleMapsKey").value = googleMaps.apiKey || "";
    $("superGoogleMapsLanguage").value = googleMaps.language || "pt-BR";
    $("superGoogleMapsRegion").value = googleMaps.region || "BR";
    $("superGoogleMapsCenterLat").value = googleMaps.center && googleMaps.center.lat || -20.8113;
    $("superGoogleMapsCenterLng").value = googleMaps.center && googleMaps.center.lng || -49.3758;
    $("superGoogleMapsRadius").value = googleMaps.radiusMeters || 90000;
    if ($("superMobileGpsEnabled")) $("superMobileGpsEnabled").value = String(mobileGps.enabled === true || mobileGps.enabled === "true");
    if ($("superMobileGpsBackend")) $("superMobileGpsBackend").value = mobileGps.backend || "realtime_database";
    if ($("superMobileGpsDatabaseURL")) $("superMobileGpsDatabaseURL").value = mobileGps.databaseURL || "";
    if ($("superMobileGpsPolling")) $("superMobileGpsPolling").value = mobileGps.pollingMs || 10000;
    if ($("superMobileGpsMinInterval")) $("superMobileGpsMinInterval").value = mobileGps.minIntervalMs || 20000;
    if ($("superMobileGpsMinDistance")) $("superMobileGpsMinDistance").value = mobileGps.minDistanceMeters || 25;
  }

  function currentVehicles() {
    const base = Object.assign({}, cfg.tracker && cfg.tracker.vehicles || {}, settings.tracker && settings.tracker.vehicles || {});
    base.FHA4B30 = Object.assign({ placa: "FHA4B30", apelido: "Guincho", tipo: "Guincho plataforma" }, base.FHA4B30 || {}, { trackerId: $("trackerFha").value.trim() || "FHA4B30" });
    base.DAJ6J95 = Object.assign({ placa: "DAJ6J95", apelido: "Munk", tipo: "Caminhao munck" }, base.DAJ6J95 || {}, { trackerId: $("trackerDaj").value.trim() || "DAJ6J95" });
    return base;
  }

  async function seedBase() {
    const batch = db.batch();
    const now = new Date().toISOString();
    Object.entries(currentVehicles()).forEach(([id, vehicle]) => {
      batch.set(db.collection("vehicles").doc(id), {
        placa: vehicle.placa || id,
        apelido: vehicle.apelido || "",
        tipo: vehicle.tipo || "",
        trackerId: vehicle.trackerId || id,
        status: "Disponível",
        updatedAt: now
      }, { merge: true });
    });
    batch.set(db.collection("settings").doc("integrations"), {
      tracker: Object.assign({}, cfg.tracker || {}, settings.tracker || {}, { vehicles: currentVehicles() }),
      cloudinary: Object.assign({}, cfg.cloudinary || {}, settings.cloudinary || {}),
      map: Object.assign({}, cfg.map || {}, settings.map || {}),
      mobileGps: Object.assign({}, cfg.mobileGps || {}, settings.mobileGps || {}),
      updatedAt: now
    }, { merge: true });
    await batch.commit();
    await ensureLegacyRafaProvider(now);
    toast("Base JM criada/atualizada com FHA4B30 e DAJ6J95.", "ok");
  }

  async function syncTracker() {
    const tracker = Object.assign({}, mergeNonEmpty(cfg.tracker || {}, settings.tracker || {}), { vehicles: currentVehicles() });
    const providers = Object.values(trackerProviders || {});
    if (!providers.some((p) => p.active !== false) && (!tracker.endpoint || !tracker.token)) {
      toast("Configure endpoint e token do Tracker antes de sincronizar.", "danger");
      return;
    }
    try {
      const positions = window.JM.tracker.syncAllTrackersToFirestore
        ? await window.JM.tracker.syncAllTrackersToFirestore({ legacyTracker: tracker, providers, db, vehicles })
        : await window.JM.tracker.syncTrackerToFirestore(tracker, db, vehicles);
      const matched = positions.filter((p) => p.trackerMatched).length;
      const unmapped = positions.length - matched;
      const detail = unmapped > 0 ? ` ${unmapped} sem vinculo com placa; preencha o deviceId/uniqueId correto em Rastreadores da frota.` : "";
      toast(`${positions.length} posição(ões) sincronizada(s), ${matched} vinculada(s).${detail}`, unmapped > 0 ? "warn" : "ok");
    } catch (err) {
      console.error(err);
      toast("Tracker indisponível: " + (err && err.message || err), "danger");
    }
  }

  function legacyRafaProviderPayload(now) {
    const tracker = Object.assign({}, cfg.tracker || {}, settings.tracker || {}, {
      platformUrl: $("trackerPlatform") ? $("trackerPlatform").value.trim() : "",
      endpoint: $("trackerEndpoint") ? $("trackerEndpoint").value.trim() : "",
      socketUrl: $("trackerSocket") ? $("trackerSocket").value.trim() : "",
      token: $("trackerToken") ? $("trackerToken").value.trim() : "",
      tokenHeader: $("trackerHeader") ? $("trackerHeader").value.trim() || "Authorization" : "Authorization",
      tokenPrefix: $("trackerPrefix") ? $("trackerPrefix").value : "Bearer ",
      pollingMs: $("trackerPolling") ? Number($("trackerPolling").value || 30000) : 30000,
      vehicles: currentVehicles()
    });
    return {
      name: "RAFA Rastreamento",
      providerType: "rafa",
      active: !!(tracker.endpoint && tracker.token),
      priority: 1,
      platformUrl: tracker.platformUrl || "",
      endpoint: tracker.endpoint || "",
      socketUrl: tracker.socketUrl || "",
      token: tracker.token || "",
      tokenHeader: tracker.tokenHeader || "Authorization",
      tokenPrefix: tracker.tokenPrefix == null ? "Bearer " : tracker.tokenPrefix,
      pollingMs: Number(tracker.pollingMs || 30000),
      timeoutMs: 15000,
      notes: "Provedor RAFA preservado a partir da configuração legada.",
      vehicles: tracker.vehicles || {},
      updatedAt: now,
      updatedBy: auth.currentUser && auth.currentUser.uid || ""
    };
  }

  async function ensureLegacyRafaProvider(now) {
    const payload = legacyRafaProviderPayload(now || new Date().toISOString());
    if (!payload.endpoint && !payload.token) return;
    await db.collection("trackerProviders").doc("rafa").set(Object.assign({
      createdAt: now || new Date().toISOString(),
      createdBy: auth.currentUser && auth.currentUser.uid || ""
    }, payload), { merge: true });
  }

  function providerPayloadFromForm() {
    const now = new Date().toISOString();
    return {
      name: $("trackerProviderName").value.trim(),
      providerType: $("trackerProviderType").value || "custom_api",
      active: $("trackerProviderActive").value === "true",
      priority: Number($("trackerProviderPriority").value || 50),
      endpoint: $("trackerProviderEndpoint").value.trim(),
      socketUrl: $("trackerProviderSocket").value.trim(),
      token: $("trackerProviderToken").value.trim(),
      tokenHeader: $("trackerProviderHeader").value.trim() || "Authorization",
      tokenPrefix: $("trackerProviderPrefix").value,
      pollingMs: Number($("trackerProviderPolling").value || 30000),
      timeoutMs: Number($("trackerProviderTimeout").value || 15000),
      notes: $("trackerProviderNotes").value.trim(),
      updatedAt: now,
      updatedBy: auth.currentUser && auth.currentUser.uid || ""
    };
  }

  function providerDocId(payload) {
    const base = String(payload.name || payload.providerType || "rastreador").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return (base || "rastreador") + "-" + String(payload.providerType || "custom").slice(0, 12);
  }

  function resetProviderForm() {
    if ($("trackerProviderForm")) $("trackerProviderForm").reset();
    if ($("trackerProviderEditId")) $("trackerProviderEditId").value = "";
    if ($("trackerProviderHeader")) $("trackerProviderHeader").value = "Authorization";
    if ($("trackerProviderPrefix")) $("trackerProviderPrefix").value = "Bearer ";
    if ($("trackerProviderPriority")) $("trackerProviderPriority").value = "50";
    if ($("trackerProviderPolling")) $("trackerProviderPolling").value = "30000";
    if ($("trackerProviderTimeout")) $("trackerProviderTimeout").value = "15000";
    if ($("trackerProviderCancelEdit")) $("trackerProviderCancelEdit").classList.add("hidden");
  }

  function renderTrackerProviders() {
    const box = $("trackerProvidersList");
    if (!box) return;
    const rows = Object.values(trackerProviders || {}).sort((a, b) => Number(a.priority || 50) - Number(b.priority || 50));
    box.innerHTML = rows.length ? rows.map((p) => {
      const status = p.active !== false ? "Ativo" : "Inativo";
      const located = Number(p.lastLocatedCount || 0);
      return `<div class="tracker-provider-card col-4">
        <b>${esc(p.name || p.id)}</b><br>
        <span class="badge ${p.active !== false ? "ok" : "muted"}">${esc(status)}</span>
        <span class="badge info">${esc(p.providerType || "custom_api")}</span>
        <p class="small">Prioridade ${esc(p.priority || 50)}<br>Última sincronização: ${esc(p.lastSyncAt || "nunca")}<br>Veículos localizados: ${located}<br>${p.lastError ? "Erro: " + esc(p.lastError) : "Erro: nenhum"}</p>
        <div class="actions">
          <button class="btn" type="button" onclick="JM.superadmin.editTrackerProvider('${esc(p.id)}')">Editar</button>
          <button class="btn" type="button" onclick="JM.superadmin.testTrackerProvider('${esc(p.id)}')">Testar</button>
          <button class="btn warn" type="button" onclick="JM.superadmin.toggleTrackerProvider('${esc(p.id)}')">${p.active !== false ? "Desativar" : "Ativar"}</button>
        </div>
      </div>`;
    }).join("") : `<p class="muted small">Nenhum rastreador adicional cadastrado. O RAFA legado continua funcionando pela configuração Tracker.</p>`;
  }

  async function testProviderConfig(provider, feedbackId) {
    const feedback = feedbackId ? $(feedbackId) : $("trackerProviderTestResult");
    if (feedback) feedback.textContent = "Testando conexão do rastreador...";
    if (!provider || !provider.endpoint) {
      const msg = "Endpoint não configurado. O provedor pode ficar cadastrado, mas não será sincronizado.";
      if (feedback) feedback.textContent = msg;
      toast(msg, "warn");
      return [];
    }
    if (!provider.token && !["manual", "mobile_gps"].includes(provider.providerType)) {
      const msg = "Token/API key não informado. Verifique autenticação antes de ativar o provedor.";
      if (feedback) feedback.textContent = msg;
      toast(msg, "warn");
      return [];
    }
    const positions = await window.JM.tracker.fetchTrackerPositions(provider);
    const msg = `Conexão concluída. ${positions.length} posição(ões) recebida(s).`;
    if (feedback) feedback.textContent = msg;
    toast(msg, positions.length ? "ok" : "warn");
    return positions;
  }

  $("companyForm").onsubmit = async (e) => {
    e.preventDefault();
    await db.collection("settings").doc("company").set({
      nome: $("companyName").value.trim(),
      cidadeBase: $("companyCity").value.trim(),
      telefoneOperacional: $("companyPhone").value.trim(),
      updatedAt: new Date().toISOString()
    }, { merge: true });
    toast("Cadastro do JM salvo.", "ok");
  };

  $("trackerForm").onsubmit = async (e) => {
    e.preventDefault();
    await db.collection("settings").doc("integrations").set({
      tracker: {
        platformUrl: $("trackerPlatform").value.trim(),
        endpoint: $("trackerEndpoint").value.trim(),
        socketUrl: $("trackerSocket") ? $("trackerSocket").value.trim() : "",
        token: $("trackerToken").value.trim(),
        tokenHeader: $("trackerHeader").value.trim() || "Authorization",
        tokenPrefix: $("trackerPrefix").value,
        pollingMs: Number($("trackerPolling").value || 30000),
        vehicles: currentVehicles()
      },
      updatedAt: new Date().toISOString()
    }, { merge: true });
    await ensureLegacyRafaProvider(new Date().toISOString());
    toast("Tracker salvo. O mapa do jm.html usará posições reais na próxima sincronização.", "ok");
  };

  $("trackerVehiclesForm").onsubmit = async (e) => {
    e.preventDefault();
    await db.collection("settings").doc("integrations").set({
      tracker: Object.assign({}, cfg.tracker || {}, settings.tracker || {}, { vehicles: currentVehicles() }),
      updatedAt: new Date().toISOString()
    }, { merge: true });
    toast("IDs dos rastreadores salvos.", "ok");
  };

  $("superCloudForm").onsubmit = async (e) => {
    e.preventDefault();
    await db.collection("settings").doc("integrations").set({
      cloudinary: {
        cloudName: $("superCloudName").value.trim(),
        uploadPreset: $("superCloudPreset").value.trim(),
        folder: "jm-guinchos"
      },
      updatedAt: new Date().toISOString()
    }, { merge: true });
    toast("Cloudinary salvo.", "ok");
  };

  $("superGoogleMapsForm").onsubmit = async (e) => {
    e.preventDefault();
    const apiKey = $("superGoogleMapsKey").value.trim();
    await db.collection("settings").doc("integrations").set({
      map: {
        provider: apiKey ? "google_maps_optional" : "leaflet_osm",
        paidApi: !!apiKey,
        apiKey,
        language: $("superGoogleMapsLanguage").value.trim() || "pt-BR",
        region: $("superGoogleMapsRegion").value.trim() || "BR",
        country: "br",
        center: {
          lat: Number(String($("superGoogleMapsCenterLat").value || "-20.8113").replace(",", ".")),
          lng: Number(String($("superGoogleMapsCenterLng").value || "-49.3758").replace(",", "."))
        },
        radiusMeters: Number($("superGoogleMapsRadius").value || 90000),
        averageSpeedKmH: 48
      },
      updatedAt: new Date().toISOString()
    }, { merge: true });
    toast(apiKey ? "Google Maps opcional salvo. O sistema usará Places/Geocoding quando disponível." : "Configuração de mapa salva com rota por ruas e fallback estimado.", "ok");
  };

  if ($("superMobileGpsForm")) $("superMobileGpsForm").onsubmit = async (e) => {
    e.preventDefault();
    const enabled = $("superMobileGpsEnabled").value === "true";
    const backend = $("superMobileGpsBackend").value || "realtime_database";
    const databaseURL = $("superMobileGpsDatabaseURL").value.trim();
    if (enabled && backend === "realtime_database" && !databaseURL) {
      return toast("Informe a Realtime Database URL ou escolha Firestore legado.", "danger");
    }
    await db.collection("settings").doc("integrations").set({
      mobileGps: {
        enabled,
        backend,
        databaseURL,
        pollingMs: Number($("superMobileGpsPolling").value || 10000),
        minIntervalMs: Number($("superMobileGpsMinInterval").value || 20000),
        minDistanceMeters: Number($("superMobileGpsMinDistance").value || 25)
      },
      updatedAt: new Date().toISOString()
    }, { merge: true });
    toast(enabled ? "Módulo GPS por celular ativado." : "Módulo GPS por celular desativado. Painéis irão ocultar esta função.", enabled ? "ok" : "warn");
  };

  if ($("trackerProviderForm")) $("trackerProviderForm").onsubmit = async (e) => {
    e.preventDefault();
    const payload = providerPayloadFromForm();
    if (!payload.name) return toast("Informe o nome do provedor.", "danger");
    if (payload.active && !payload.endpoint && !["manual", "mobile_gps"].includes(payload.providerType)) {
      return toast("Para ativar este rastreador, informe o endpoint real da API.", "danger");
    }
    const id = $("trackerProviderEditId").value || providerDocId(payload);
    await db.collection("trackerProviders").doc(id).set(Object.assign({
      createdAt: new Date().toISOString(),
      createdBy: auth.currentUser && auth.currentUser.uid || ""
    }, payload), { merge: true });
    resetProviderForm();
    toast("Rastreador salvo.", "ok");
  };

  if ($("trackerProviderTestBtn")) $("trackerProviderTestBtn").onclick = async () => {
    try {
      await testProviderConfig(providerPayloadFromForm(), "trackerProviderTestResult");
    } catch (err) {
      const msg = "Não consegui conectar ao rastreador. Verifique endpoint, token e CORS. O sistema continuará usando RAFA/GPS celular se disponível. Detalhe: " + (err && err.message || err);
      if ($("trackerProviderTestResult")) $("trackerProviderTestResult").textContent = msg;
      toast(msg, "danger");
    }
  };

  if ($("trackerProviderCancelEdit")) $("trackerProviderCancelEdit").onclick = resetProviderForm;

  function normalizedRole(role) {
    return String(role || "").toLowerCase().trim();
  }

  function isOfficeRole(role) {
    return ["admin", "gestor", "gerente", "auxiliar", "atendente", "finance", "manager", "owner"].includes(normalizedRole(role));
  }

  function isDriverRole(role) {
    return ["driver", "motorista"].includes(normalizedRole(role));
  }

  function roleLabel(role) {
    const labels = {
      owner: "Dono/Gestor master",
      admin: "Gestor/Admin",
      gestor: "Gestor",
      gerente: "Gerente",
      auxiliar: "Auxiliar",
      atendente: "Atendente",
      driver: "Motorista",
      motorista: "Motorista",
      finance: "Financeiro"
    };
    return labels[normalizedRole(role)] || role || "Usuário";
  }

  $("adminUserForm").onsubmit = async (e) => {
    e.preventDefault();
    const email = $("adminEmail").value.trim().toLowerCase();
    const pass = $("adminPass").value;
    const nome = $("adminName").value.trim();
    const role = normalizedRole($("adminRole") ? $("adminRole").value : "admin") || "admin";
    if (!pass || pass.length < 6) return toast("Senha mínima: 6 caracteres.", "danger");

    const userPayload = {
      nome,
      email,
      role,
      active: true,
      updatedAt: new Date().toISOString(),
      updatedBy: auth.currentUser && auth.currentUser.uid || "",
      source: "superadmin-adminUserForm"
    };

    try {
      if (isOfficeRole(role)) {
        await db.collection("managerAccess").doc(email).set(Object.assign({ createdAt: new Date().toISOString() }, userPayload), { merge: true });
      }
      if (isDriverRole(role)) {
        await db.collection("driverAccess").doc(email).set(Object.assign({ createdAt: new Date().toISOString() }, userPayload), { merge: true });
      }

      const oldUsers = await db.collection("users").where("email", "==", email).get();
      if (!oldUsers.empty) {
        const batch = db.batch();
        oldUsers.forEach((doc) => {
          batch.set(doc.ref, Object.assign({}, userPayload, {
            active: true,
            fixedAt: new Date().toISOString()
          }), { merge: true });
        });
        await batch.commit();
      }

      let cred = null;
      try {
        cred = await secondaryAuth.createUserWithEmailAndPassword(email, pass);
        await secondaryAuth.signOut().catch(() => {});
      } catch (err) {
        if (!(err && err.code === "auth/email-already-in-use")) throw err;
        e.target.reset();
        toast("Este e-mail já existia no Auth. O perfil " + roleLabel(role) + " foi salvo/liberado; no primeiro login o sistema repara o UID se precisar.", "ok");
        return;
      }

      await db.collection("users").doc(cred.user.uid).set(Object.assign({}, userPayload, {
        uid: cred.user.uid,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: auth.currentUser && auth.currentUser.uid || ""
      }), { merge: true });
      e.target.reset();
      toast(roleLabel(role) + " criado no Auth e salvo na equipe.", "ok");
    } catch (err) {
      toast(friendlyAuthError(err), "danger");
    }
  };

  if (window.JM.utils && typeof window.JM.utils.setupCollapsiblePanels === "function") {
    window.JM.utils.setupCollapsiblePanels(document, { collapseOnMobile: true, openFirst: 2 });
    setTimeout(() => window.JM.utils.setupCollapsiblePanels(document, { collapseOnMobile: true, openFirst: 2 }), 250);
  }

  window.JM.superadmin = {
    editTrackerProvider(id) {
      const p = trackerProviders[id];
      if (!p) return toast("Rastreador não encontrado.", "danger");
      $("trackerProviderEditId").value = id;
      $("trackerProviderName").value = p.name || "";
      $("trackerProviderType").value = p.providerType || "custom_api";
      $("trackerProviderActive").value = String(p.active !== false);
      $("trackerProviderPriority").value = p.priority || 50;
      $("trackerProviderEndpoint").value = p.endpoint || "";
      $("trackerProviderSocket").value = p.socketUrl || "";
      $("trackerProviderHeader").value = p.tokenHeader || "Authorization";
      $("trackerProviderPrefix").value = p.tokenPrefix == null ? "Bearer " : p.tokenPrefix;
      $("trackerProviderToken").value = p.token || "";
      $("trackerProviderPolling").value = p.pollingMs || 30000;
      $("trackerProviderTimeout").value = p.timeoutMs || 15000;
      $("trackerProviderNotes").value = p.notes || "";
      if ($("trackerProviderCancelEdit")) $("trackerProviderCancelEdit").classList.remove("hidden");
      toast("Rastreador carregado para edição.", "ok");
    },
    async toggleTrackerProvider(id) {
      const p = trackerProviders[id];
      if (!p) return toast("Rastreador não encontrado.", "danger");
      await db.collection("trackerProviders").doc(id).set({
        active: p.active === false,
        updatedAt: new Date().toISOString(),
        updatedBy: auth.currentUser && auth.currentUser.uid || ""
      }, { merge: true });
      toast(p.active === false ? "Rastreador ativado." : "Rastreador desativado.", "ok");
    },
    async testTrackerProvider(id) {
      const p = trackerProviders[id];
      if (!p) return toast("Rastreador não encontrado.", "danger");
      try {
        const positions = await testProviderConfig(p, "trackerProviderTestResult");
        await db.collection("trackerProviders").doc(id).set({
          lastTestAt: new Date().toISOString(),
          lastLocatedCount: positions.length,
          lastError: ""
        }, { merge: true });
      } catch (err) {
        await db.collection("trackerProviders").doc(id).set({
          lastTestAt: new Date().toISOString(),
          lastError: err && err.message || String(err)
        }, { merge: true });
        const msg = "Não consegui conectar ao rastreador. Verifique endpoint, token e CORS. Detalhe: " + (err && err.message || err);
        if ($("trackerProviderTestResult")) $("trackerProviderTestResult").textContent = msg;
        toast(msg, "danger");
      }
    }
  };

}());
