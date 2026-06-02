(function () {
  "use strict";

  const { $, esc, parseMoney, toast, statusClass, routeKm, mapsRouteUrl, statusKey, statusLabel, isFinalStatus, setupCollapsiblePanels, pointFrom } = window.JM.utils;
  const { auth, db, arrayUnion, getRealtimeDb, rtdbKey } = window.JM.firebase;
  const cfg = window.JM_CONFIG || {};
  const DRIVER_FLOW_VERSION = "jm-v28-3-desenho-checklist-tecnico";
  const state = { user: null, profile: null, calls: {}, vehicles: {}, expenses: {}, settings: {}, selectedCallId: "", driverLivePoint: null };
  const unsubscribers = [];
  let driverLocationWatchId = null;
  let lastDriverPhoneWrite = null;
  let renderTimer = null;
  let mapRenderTimer = null;
  let lastSelectSignature = "";
  let lastRenderedCallsHtml = "";
  let lastLoadedProofCallId = "";
  const PROOF_STAGES = ["retirada", "carregamento", "transporte", "entrega", "finalizacao"];
  const PROOF_STAGE_FIELDS = {
    retirada: { select: "proofStageRetirada", justification: "proofStageRetiradaJustification", label: "Retirada" },
    carregamento: { select: "proofStageCarregamento", justification: "proofStageCarregamentoJustification", label: "Carregamento" },
    transporte: { select: "proofStageTransporte", justification: "", label: "Transporte" },
    entrega: { select: "proofStageEntrega", justification: "proofStageEntregaJustification", label: "Entrega" },
    finalizacao: { select: "proofStageFinalizacao", justification: "proofStageFinalizacaoJustification", label: "Finalização" }
  };
  const REQUIRED_PHOTOS = [
    { key: "front", input: "proofPhotoFront", label: "Frente" },
    { key: "rear", input: "proofPhotoRear", label: "Traseira" },
    { key: "right", input: "proofPhotoRight", label: "Lateral direita" },
    { key: "left", input: "proofPhotoLeft", label: "Lateral esquerda" },
    { key: "dashboard", input: "proofPhotoDashboard", label: "Painel / odômetro" },
    { key: "load_after", input: "proofPhotoLoadAfter", label: "Carregado no caminhão" },
    { key: "delivery_front", input: "proofPhotoDeliveryFront", label: "Entrega - frente" },
    { key: "delivery_rear", input: "proofPhotoDeliveryRear", label: "Entrega - traseira" },
    { key: "delivery_right", input: "proofPhotoDeliveryRight", label: "Entrega - lateral direita" },
    { key: "delivery_left", input: "proofPhotoDeliveryLeft", label: "Entrega - lateral esquerda" },
    { key: "delivery_dashboard", input: "proofPhotoDeliveryDashboard", label: "Entrega - painel / odômetro" },
    { key: "damage", input: "proofPhotoDamage", label: "Avarias" },
    { key: "final", input: "proofPhotoFinal", label: "Comprovante final" }
  ];
  const DAMAGE_PARTS = [
    { key: "front", label: "Frente" },
    { key: "rear", label: "Traseira" },
    { key: "right", label: "Lateral direita" },
    { key: "left", label: "Lateral esquerda" },
    { key: "roof", label: "Teto" },
    { key: "hood", label: "Capô" },
    { key: "trunk", label: "Porta-malas" },
    { key: "windshield", label: "Para-brisa/vidros" },
    { key: "wheels", label: "Rodas/pneus" },
    { key: "underbody", label: "Parte inferior" },
    { key: "truck_bed", label: "Plataforma/guincho" },
    { key: "other", label: "Outro ponto" }
  ];
  const ACCESSORY_GROUPS = [
    {
      title: "Parte externa do veículo",
      items: [
        ["driverMirror", "Retrovisor motorista"],
        ["passengerMirror", "Retrovisor passageiro"],
        ["fogLight", "Farol de milha"],
        ["alloyWheels", "Rodas de liga leve"],
        ["steelWheels", "Rodas de aço"],
        ["hubcaps", "Calotas"],
        ["antenna", "Antena"],
        ["trunkLid", "Porta-malas"],
        ["fireExtinguisher", "Extintor"],
        ["spareTire", "Estepe"],
        ["warningTriangle", "Triângulo"],
        ["jack", "Macaco"]
      ]
    },
    {
      title: "Painel / porta / documentos",
      items: [
        ["ignitionKey", "Chave de ignição"],
        ["tachograph", "Tacógrafo"],
        ["multimedia", "Multimídia"],
        ["cdPlayer", "CD Player"],
        ["dvdPlayer", "DVD Player"],
        ["radioTransmitter", "Rádio transmissor"],
        ["documents", "Documentos"],
        ["speaker", "Auto falante"]
      ]
    },
    {
      title: "Parte interna do veículo",
      items: [
        ["amplifier", "Amplificador"],
        ["console", "Console"],
        ["floorMats", "Tapetes"],
        ["rearCover", "Tampão traseiro"],
        ["driverSeat", "Banco dianteiro motorista"],
        ["passengerSeat", "Banco dianteiro passageiro"],
        ["cabinBed", "Cama gabinado"],
        ["alarm", "Alarme"]
      ]
    }
  ];
  let signaturePad = null;
  let selectedDamageParts = new Set();
  let selectedDamageNotes = {};
  let activeDamagePartKey = "";
  const ACCESSORY_STATUS_LABELS = { sim: "S", nao: "N", avaria: "A" };

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

  function visibleRows(rows) {
    return Object.values(rows || {}).filter((row) => row && !row.deletedAt);
  }

  function isSelectBusy(el) {
    if (!el) return false;
    return document.activeElement === el || el.matches && el.matches(":focus");
  }

  function optionSignature(calls, vehicles) {
    const callPart = activeCalls().map((c) => [c.id, c.protocolo || "", c.cliente || "", c.vehicleId || "", c.statusKey || c.status || ""].join("|")).join(";");
    const vehiclePart = visibleRows(vehicles || state.vehicles).map((v) => [v.id, v.placa || ""].join("|")).join(";");
    return callPart + "::" + vehiclePart;
  }

  function setSelectOptionsStable(select, html, previousValue) {
    if (!select) return;
    if (isSelectBusy(select)) return;
    const old = previousValue != null ? previousValue : select.value;
    if (select.dataset.lastOptionsHtml !== html) {
      select.innerHTML = html;
      select.dataset.lastOptionsHtml = html;
    }
    if (old && Array.from(select.options).some((opt) => opt.value === old)) select.value = old;
  }

  function scheduleRender(reason) {
    if (!state.user) return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => render(reason || "snapshot"), 180);
  }

  function scheduleMapRender(delayMs) {
    clearTimeout(mapRenderTimer);
    mapRenderTimer = setTimeout(() => {
      if (!document.getElementById("driverMap")) return;
      const panel = document.getElementById("driverPanelMap");
      if (panel && panel.classList.contains("is-collapsed")) return;
      window.JM_MAP_SETTINGS = (window.JM_CONFIG && window.JM_CONFIG.map) || {};
      window.JM.mapa.renderFleetMap("driverMap", driverVehiclesForMap(), driverCallsForMap(), { selectedCallId: state.selectedCallId || "", selectedVehicleId: selectedCallVehicleId(), filter: "todos" });
    }, Number.isFinite(Number(delayMs)) ? Number(delayMs) : 350);
  }

  function selectedCall() {
    return state.selectedCallId && state.calls[state.selectedCallId] || activeCalls()[0] || null;
  }

  function selectedCallVehicleId() {
    const call = selectedCall();
    return call && (call.vehicleId || call.vehicle || call.truckId || "") || "";
  }

  function driverCallsForMap() {
    const call = selectedCall();
    if (!call) return {};
    return { [call.id]: call };
  }

  function vehicleLivePoint(vehicle) {
    return pointFrom(vehicle && (
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

  function driverVehiclesForMap() {
    const out = Object.assign({}, state.vehicles || {});
    Object.entries(out).forEach(([id, vehicle]) => {
      const lastPoint = vehicleLivePoint(vehicle);
      if (lastPoint && !pointFrom(vehicle && vehicle.location)) {
        out[id] = Object.assign({}, vehicle, {
          location: lastPoint,
          trackerStatus: vehicle.trackerStatus || "Última localização conhecida",
          lastTrackerAt: vehicle.lastTrackerAt || vehicle.trackerLastUpdateAt || vehicle.updatedAt || ""
        });
      }
    });
    const call = selectedCall();
    const vehicleId = (call && (call.vehicleId || call.vehicle || call.truckId || "")) || ($("driverLocationVehicle") && $("driverLocationVehicle").value) || "";
    const phone = state.driverLivePoint || pointFrom(call && (call.driverPhoneLocation || call.mobileLocation || call.driverLocation));
    if (!phone || !vehicleId) return out;
    const base = out[vehicleId] || { id: vehicleId, placa: call.vehiclePlate || vehicleId };
    const hasTracker = !!vehicleLivePoint(base) && !String(base.gpsSource || base.trackerStatus || "").includes("driver_phone");
    if (!hasTracker) {
      out[vehicleId] = Object.assign({}, base, {
        location: phone,
        mobileLocation: phone,
        driverPhoneLocation: phone,
        gpsSource: "driver_phone_local",
        trackerStatus: "GPS celular motorista",
        lastPhoneGpsAt: phone.capturedAt || phone.updatedAt || ""
      });
      return out;
    }
    out[vehicleId + "__celular_motorista"] = Object.assign({}, base, {
      id: vehicleId + "__celular_motorista",
      realVehicleId: vehicleId,
      placa: (base.placa || vehicleId) + " - celular",
      apelido: "GPS celular do motorista",
      location: phone,
      mobileLocation: phone,
      driverPhoneLocation: phone,
      gpsSource: "driver_phone_local",
      trackerStatus: "GPS celular motorista",
      lastPhoneGpsAt: phone.capturedAt || phone.updatedAt || "",
      activeCallId: call.id
    });
    return out;
  }

  function setDriverRouteStatus(message, type) {
    const box = $("driverRouteStatus");
    if (!box) return;
    box.textContent = message;
    box.className = "driver-route-status " + (type || "muted");
  }

  function focusCallRoute(id, scroll) {
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado para mostrar rota.", "danger");
    state.selectedCallId = id;
    setDriverRouteStatus("Rota interna focada: " + (call.protocolo || call.cliente || id) + ". Ative o GPS do celular para acompanhar sua posição ao vivo no mapa.", "ok");
    scheduleMapRender();
    if (scroll !== false) {
      const mapPanel = $("driverPanelMap");
      if (mapPanel) mapPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function shouldPersistDriverGps(callId, pos, force, vehicleId) {
    if (force) return true;
    const now = Date.now();
    const lat = Number(pos && pos.coords && pos.coords.latitude);
    const lng = Number(pos && pos.coords && pos.coords.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    const trackId = callId || vehicleId || "driver";
    if (!lastDriverPhoneWrite || lastDriverPhoneWrite.callId !== trackId) return true;
    const gps = activeMobileGpsSettings();
    const elapsed = now - lastDriverPhoneWrite.at;
    const moved = window.JM.utils.haversineKm({ lat, lng }, { lat: lastDriverPhoneWrite.lat, lng: lastDriverPhoneWrite.lng }) * 1000;
    return elapsed >= Math.max(5000, Number(gps.minIntervalMs || 20000)) || moved >= Math.max(5, Number(gps.minDistanceMeters || 25));
  }

  function proofPhotos(call) {
    return Array.isArray(call && call.proofPhotos) ? call.proofPhotos.filter(Boolean) : [];
  }

  function hasPhotoType(call, type) {
    return proofPhotos(call).some((photo) => photo && photo.type === type && photo.cloudinaryUrl);
  }

  function hasCompleteChecklist(call) {
    const checklist = call && call.proofChecklist || {};
    return PROOF_STAGES.every((stage) => checklist[stage] && checklist[stage].status && checklist[stage].status !== "pendente");
  }

  function hasSignature(call) {
    const signature = call && call.customerSignature || {};
    const phases = call && call.phaseSignatures || {};
    return !!(
      ((signature.signatureUrl || signature.cloudinaryUrl) && signature.acceptedText) ||
      (signature.refused && signature.refusalReason && signature.acceptedText) ||
      ["retirada", "entrega", "finalizacao"].some((phase) => {
        const item = phases[phase] || {};
        return ((item.signatureUrl || item.cloudinaryUrl) && item.acceptedText) || (item.refused && item.refusalReason && item.acceptedText);
      })
    );
  }

  function phaseAccepted(call, phase) {
    const checklist = call && call.proofChecklist || {};
    const row = checklist[phase] || {};
    if (!row || row.status === "pendente") return false;
    const phases = call && call.phaseSignatures || {};
    const item = phases[phase] || {};
    const fallback = (phase === "entrega" || phase === "finalizacao") ? (call && call.customerSignature || {}) : {};
    return !!(
      row.justificativa ||
      ((item.signatureUrl || item.cloudinaryUrl) && item.acceptedText) ||
      (item.refused && item.refusalReason && item.acceptedText) ||
      ((fallback.signatureUrl || fallback.cloudinaryUrl) && fallback.acceptedText) ||
      (fallback.refused && fallback.refusalReason && fallback.acceptedText)
    );
  }

  function hasOperationalPhaseAcceptances(call) {
    return ["retirada", "entrega", "finalizacao"].every((phase) => phaseAccepted(call, phase));
  }

  function proofStatusFor(call) {
    if (!call) return "pendente";
    const checklist = call.proofChecklist || {};
    const requiredPhotos = requiredProofPhotosForChecklist(checklist);
    const missingPhotos = requiredPhotos.filter((photo) => !hasPhotoType(call, photo.key)).length;
    if (missingPhotos === 0 && hasCompleteChecklist(call) && hasOperationalPhaseAcceptances(call)) return "completo";
    if (proofPhotos(call).length || call.proofChecklist || call.customerSignature) return "parcial";
    return "pendente";
  }

  function publicStatusLabel(callOrStatus) {
    const key = statusKey(callOrStatus);
    const labels = {
      aguardando_despacho: "Atendimento recebido",
      despachado: "Guincho em preparação",
      motorista_a_caminho: "Motorista a caminho",
      motorista_no_local: "Motorista chegou ao local",
      veiculo_carregado: "Veículo carregado",
      em_transporte: "Veículo em remoção/transporte",
      entregue: "Veículo entregue",
      finalizado: "Atendimento finalizado",
      cancelado: "Atendimento cancelado"
    };
    return labels[key] || "Atendimento recebido";
  }

  async function syncPublicCallFromDriver(call, extra) {
    const merged = Object.assign({}, call || {});
    Object.entries(extra || {}).forEach(([key, value]) => {
      if (key === "timeline" && !Array.isArray(value)) return;
      merged[key] = value;
    });
    call = merged;
    if (!call.publicToken || call.publicRevoked) return;
    const photos = call.publicProofsEnabled ? (Array.isArray(call.proofPhotos) ? call.proofPhotos : []).filter((p) => p && p.cloudinaryUrl).map((p) => ({
      label: p.label || p.type || "Foto",
      url: p.cloudinaryUrl,
      type: p.type || "",
      uploadedAt: p.uploadedAt || ""
    })) : [];
    await db.collection("publicCalls").doc(call.publicToken).set({
      publicToken: call.publicToken,
      callId: call.id,
      companyName: "JM Guinchos",
      statusPublic: publicStatusLabel(call.statusKey || call.status),
      statusKey: statusKey(call.statusKey || call.status),
      serviceType: call.serviceType || call.tipo || "Guincho",
      clientNameMasked: call.cliente || call.customerName || "Cliente",
      vehiclePlateMasked: call.customerPlate || "",
      customerVehicle: call.customerVehicle || "",
      timelinePublic: Array.isArray(call.timeline) ? call.timeline.slice(-20) : [],
      proofsPublic: photos,
      damageAssessmentPublic: call.publicProofsEnabled ? (call.damageAssessment || call.proofChecklist && call.proofChecklist.damageAssessment || null) : null,
      customerSignaturePublic: call.publicProofsEnabled ? (call.customerSignature || null) : null,
      phaseSignaturesPublic: call.publicProofsEnabled ? (call.phaseSignatures || {}) : {},
      reportEnabled: call.publicReportEnabled !== false,
      chatEnabled: call.publicChatEnabled !== false,
      paymentNegotiationEnabled: call.publicPaymentNegotiationEnabled === true,
      updatedAt: new Date().toISOString(),
      revoked: false
    }, { merge: true });
  }

  function proofBadge(call) {
    const status = call && (call.proofStatus || proofStatusFor(call)) || "pendente";
    const cls = status === "revisado" || status === "completo" ? "ok" : status === "parcial" ? "warn" : "danger";
    return `<span class="badge ${cls}">Provas: ${esc(status)}</span>`;
  }

  function callDisplayName(call) {
    if (!call) return "";
    return call.insurance || call.billingParty || call.cliente || call.customerName || call.protocolo || "";
  }

  function callProtocolLabel(call, fallbackId) {
    return call && (call.protocolo || call.insuranceProtocol || call.id) || fallbackId || "";
  }

  function normalizeCostText(value) {
    return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  }

  function isVehicleCostType(type, notes) {
    const text = normalizeCostText(String(type || "") + " " + String(notes || ""));
    return /combustivel|diesel|gasolina|etanol|arla|pedagio|estacionamento|lavagem|alimentacao|manutenc|revis|oleo|pneu|freio|suspens|eletric|borrachar|mecanica|motor|cambio|guincho|munck|plataforma|peca|pecas/.test(text);
  }

  function isMaintenanceExpenseType(type, notes) {
    const text = normalizeCostText(String(type || "") + " " + String(notes || ""));
    return /manutenc|revis|oleo|pneu|freio|suspens|eletric|mecanica|motor|cambio|guincho|munck|plataforma|borrachar|peca|pecas/.test(text);
  }

  function vehicleCostKind(type, notes) {
    return isMaintenanceExpenseType(type, notes) ? "maintenance" : isVehicleCostType(type, notes) ? "operational" : "general";
  }


  function syncDriverExpenseContext() {
    const callId = $("driverExpenseCall") && $("driverExpenseCall").value;
    const call = callId && state.calls[callId];
    const vehicleSelect = $("driverExpenseVehicle");
    const box = $("driverExpenseContext");
    if (!vehicleSelect) return;
    if (call && call.vehicleId) {
      vehicleSelect.value = call.vehicleId;
      const vehicle = state.vehicles[call.vehicleId] || {};
      if (box) box.innerHTML = `Vinculado automaticamente ao chamado <b>${esc(callProtocolLabel(call, callId))}</b>, veículo <b>${esc(vehicle.placa || call.vehicleId)}</b> e pagador <b>${esc(callDisplayName(call) || "não informado")}</b>.`;
    } else if (box) {
      box.textContent = callId ? "Chamado sem veículo definido. Selecione o veículo manualmente." : "Escolha um chamado para puxar veículo, protocolo e seguradora automaticamente.";
    }
  }

  function mergeNonEmpty(base, override) {
    const out = Object.assign({}, base || {});
    Object.entries(override || {}).forEach(([key, value]) => {
      if (value === "" || value == null) return;
      out[key] = value;
    });
    return out;
  }

  function activeCloudinaryConfig() {
    return mergeNonEmpty(cfg.cloudinary || {}, state.settings.cloudinary || {});
  }

  function activeMobileGpsSettings() {
    const base = mergeNonEmpty(cfg.mobileGps || {}, state.settings.mobileGps || {});
    return Object.assign({ enabled: false, backend: "firestore", databaseURL: "", pollingMs: 10000, minIntervalMs: 20000, minDistanceMeters: 25 }, base || {});
  }

  function isMobileGpsEnabled() {
    const gps = activeMobileGpsSettings();
    return gps.enabled === true || gps.enabled === "true";
  }

  function isMobileGpsRealtime() {
    const gps = activeMobileGpsSettings();
    return isMobileGpsEnabled() && String(gps.backend || "firestore") === "realtime_database" && !!String(gps.databaseURL || "").trim();
  }

  function applyMobileGpsVisibility() {
    const enabled = isMobileGpsEnabled();
    ["driverPanelLocation"].forEach((id) => { const el = $(id); if (el) el.classList.toggle("hidden", !enabled); });
    document.querySelectorAll("[data-mobile-gps-only]").forEach((el) => el.classList.toggle("hidden", !enabled));
    if (!enabled) {
      stopDriverPhoneLocation();
      setDriverLocationStatus("Módulo de localização por celular desativado no superadmin.", "muted");
    }
  }

  function setProofSubmitStatus(message, type, alsoToast) {
    const box = $("driverProofStatus");
    const kind = type || "info";
    if (box) {
      box.textContent = message;
      box.className = "wide proof-submit-status " + kind;
      box.hidden = false;
      try { box.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (_) {}
    }
    if (alsoToast !== false) toast(message, kind === "success" ? "ok" : kind);
  }

  function requiredProofPhotosForChecklist(checklist) {
    checklist = checklist || {};
    const required = [];
    const add = (keys) => keys.forEach((key) => {
      const photo = REQUIRED_PHOTOS.find((item) => item.key === key);
      if (photo && !required.some((item) => item.key === key)) required.push(photo);
    });
    if (checklist.retirada && !["pendente", "justificado"].includes(checklist.retirada.status)) add(["front", "rear", "right", "left", "dashboard"]);
    if (checklist.carregamento && !["pendente", "justificado"].includes(checklist.carregamento.status)) add(["front", "rear", "right", "left", "dashboard", "load_after"]);
    if (checklist.entrega && !["pendente", "justificado"].includes(checklist.entrega.status)) add(["delivery_front", "delivery_rear", "delivery_right", "delivery_left", "delivery_dashboard", "final"]);
    const hasAvaria = Object.values(checklist).some((item) => item && String(item.status || "").toLowerCase().includes("avaria"));
    if (hasAvaria) add(["damage"]);
    return required;
  }

  function proofPhotoLabelList(photos) {
    return (photos || []).map((photo) => photo.label || photo.key).join(", ");
  }

  function imageFileToCanvas(file, maxSide, quality) {
    return new Promise((resolve) => {
      if (!file || !/^image\//i.test(file.type || "")) return resolve(file);
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        try {
          const width = img.naturalWidth || img.width;
          const height = img.naturalHeight || img.height;
          const biggest = Math.max(width, height);
          if (!width || !height || biggest <= maxSide) {
            URL.revokeObjectURL(url);
            return resolve(file);
          }
          const scale = maxSide / biggest;
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            URL.revokeObjectURL(url);
            if (!blob) return resolve(file);
            const name = String(file.name || "foto.jpg").replace(/\.[a-z0-9]+$/i, "") + ".jpg";
            resolve(new File([blob], name, { type: "image/jpeg", lastModified: Date.now() }));
          }, "image/jpeg", quality || 0.82);
        } catch (_) {
          URL.revokeObjectURL(url);
          resolve(file);
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  function getCurrentPositionSafe() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy || null,
          capturedAt: new Date().toISOString()
        }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 7000, maximumAge: 60000 }
      );
    });
  }

  function setupSignaturePad() {
    const canvas = $("signatureCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    function resizeSignatureCanvas() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const w = Math.max(320, Math.round(rect.width * dpr));
      const h = Math.max(180, Math.round((rect.height || 260) * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        const old = signaturePad && signaturePad.dirty ? canvas.toDataURL("image/png") : "";
        canvas.width = w;
        canvas.height = h;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.lineWidth = 3.2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#e6edf7";
        if (old) {
          const img = new Image();
          img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
          img.src = old;
        }
      }
    }
    signaturePad = { canvas, ctx, drawing: false, dirty: false, enabled: false, pointerId: null, lastPoint: null };
    resizeSignatureCanvas();
    function setSignatureMode(enabled) {
      signaturePad.enabled = !!enabled;
      canvas.classList.toggle("is-signing", signaturePad.enabled);
      canvas.classList.toggle("is-scroll-mode", !signaturePad.enabled);
      const btn = $("toggleSignatureModeBtn");
      const hint = $("signatureModeHint");
      if (btn) {
        btn.textContent = signaturePad.enabled ? "Concluir assinatura" : "Ativar assinatura";
        btn.setAttribute("aria-pressed", signaturePad.enabled ? "true" : "false");
        btn.classList.toggle("good", signaturePad.enabled);
      }
      if (hint) {
        hint.textContent = signaturePad.enabled
          ? "Modo assinatura ativo. Assine dentro do quadro; toque em Concluir assinatura para voltar a rolar a tela normalmente."
          : "Modo assinatura desligado. Voce pode rolar a tela passando o dedo sobre a area da assinatura.";
      }
    }
    function point(evt) {
      const rect = canvas.getBoundingClientRect();
      const src = evt.touches && evt.touches[0] || evt;
      const x = Math.max(0, Math.min(rect.width, src.clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height, src.clientY - rect.top));
      return {
        x,
        y
      };
    }
    function start(evt) {
      if (!signaturePad.enabled) return;
      evt.preventDefault();
      resizeSignatureCanvas();
      const p = point(evt);
      signaturePad.drawing = true;
      signaturePad.dirty = true;
      signaturePad.pointerId = evt.pointerId == null ? null : evt.pointerId;
      signaturePad.lastPoint = p;
      try { if (evt.pointerId != null) canvas.setPointerCapture(evt.pointerId); } catch (_) {}
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    }
    function move(evt) {
      if (!signaturePad.drawing) return;
      evt.preventDefault();
      if (signaturePad.pointerId != null && evt.pointerId != null && evt.pointerId !== signaturePad.pointerId) return;
      const p = point(evt);
      const last = signaturePad.lastPoint || p;
      const mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
      ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      signaturePad.lastPoint = p;
    }
    function end(evt) {
      if (evt) evt.preventDefault();
      if (signaturePad.pointerId != null && evt && evt.pointerId != null && evt.pointerId !== signaturePad.pointerId) return;
      signaturePad.drawing = false;
      signaturePad.pointerId = null;
      signaturePad.lastPoint = null;
      try { if (evt && evt.pointerId != null) canvas.releasePointerCapture(evt.pointerId); } catch (_) {}
    }
    canvas.addEventListener("pointerdown", start, { passive: false });
    canvas.addEventListener("pointermove", move, { passive: false });
    canvas.addEventListener("pointerup", end, { passive: false });
    canvas.addEventListener("pointercancel", end, { passive: false });
    canvas.addEventListener("pointerleave", end, { passive: false });
    window.addEventListener("resize", () => resizeSignatureCanvas());
    if ($("toggleSignatureModeBtn")) $("toggleSignatureModeBtn").onclick = () => setSignatureMode(!signaturePad.enabled);
    if ($("clearSignatureBtn")) $("clearSignatureBtn").onclick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      signaturePad.dirty = false;
      signaturePad.lastPoint = null;
    };
    setSignatureMode(false);
  }

  function signatureBlob() {
    return new Promise((resolve) => {
      if (!signaturePad || !signaturePad.dirty) return resolve(null);
      signaturePad.canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  function stageSelect(stage) {
    const cfg = PROOF_STAGE_FIELDS[stage] || {};
    return cfg.select ? $(cfg.select) : null;
  }

  function refreshStageButtons(stage) {
    const select = stageSelect(stage);
    const host = document.querySelector(`.proof-stage-buttons[data-stage="${stage}"]`);
    if (!select || !host) return;
    host.querySelectorAll("button").forEach((btn) => {
      const active = btn.dataset.value === select.value;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function setProofStageValue(stage, value, touched) {
    const select = stageSelect(stage);
    if (!select) return;
    select.value = value || "pendente";
    select.dataset.touched = touched ? "true" : "false";
    refreshStageButtons(stage);
  }

  function focusStageJustification(stage, value) {
    const cfg = PROOF_STAGE_FIELDS[stage] || {};
    const needsText = ["avaria", "intercorrencia", "recusa", "justificado"].includes(String(value || ""));
    if (!needsText || !cfg.justification || !$(cfg.justification)) return;
    setTimeout(() => $(cfg.justification).focus(), 80);
  }

  function setupProofStageButtons() {
    PROOF_STAGES.forEach((stage) => {
      const select = stageSelect(stage);
      if (!select || select.dataset.buttonized === "true") return;
      select.dataset.buttonized = "true";
      select.classList.add("proof-stage-native-select");
      const host = document.createElement("div");
      host.className = "proof-stage-buttons";
      host.dataset.stage = stage;
      host.innerHTML = Array.from(select.options).map((option) => (
        `<button class="proof-stage-choice" type="button" data-value="${esc(option.value)}" aria-pressed="false">${esc(option.textContent || option.value)}</button>`
      )).join("");
      select.insertAdjacentElement("afterend", host);
      host.addEventListener("click", (event) => {
        const btn = event.target && event.target.closest && event.target.closest("button[data-value]");
        if (!btn) return;
        select.value = btn.dataset.value || "pendente";
        select.dataset.touched = "true";
        refreshStageButtons(stage);
        focusStageJustification(stage, select.value);
      });
      select.addEventListener("change", () => {
        select.dataset.touched = "true";
        refreshStageButtons(stage);
        focusStageJustification(stage, select.value);
      });
      refreshStageButtons(stage);
    });
  }

  function updateDamageSummary() {
    const summary = $("damagePartsSummary");
    if (!summary) return;
    const labels = Array.from(selectedDamageParts).map((key) => {
      const item = DAMAGE_PARTS.find((part) => part.key === key);
      const note = selectedDamageNotes[key] ? " - " + selectedDamageNotes[key] : "";
      return (item && item.label || key) + note;
    });
    summary.textContent = labels.length ? "Avarias marcadas: " + labels.join(", ") : "Nenhum ponto de avaria marcado no desenho.";
  }

  function damagePartsForType(type) {
    if (String(type || "") === "caminhao") return DAMAGE_PARTS;
    return DAMAGE_PARTS.filter((part) => part.key !== "truck_bed");
  }

  function damageVehicleSvg(type) {
    if (String(type || "") === "moto") {
      return `<svg viewBox="0 0 920 520" role="img" aria-label="Prancha técnica de moto para checklist de avarias">
        <defs>
          <linearGradient id="motoPanel" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#e5e7eb"/></linearGradient>
          <linearGradient id="motoBlue" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#dbeafe"/><stop offset="50%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0f766e"/></linearGradient>
          <radialGradient id="motoTire" cx="50%" cy="50%" r="55%"><stop offset="0%" stop-color="#f8fafc"/><stop offset="42%" stop-color="#475569"/><stop offset="100%" stop-color="#020617"/></radialGradient>
          <filter id="motoPaperShadow" x="-5%" y="-5%" width="110%" height="120%"><feDropShadow dx="0" dy="10" stdDeviation="8" flood-color="#000" flood-opacity=".18"/></filter>
        </defs>
        <rect x="18" y="18" width="884" height="484" rx="18" fill="url(#motoPanel)" stroke="#cbd5e1" stroke-width="4" filter="url(#motoPaperShadow)"/>
        <g font-family="Arial, sans-serif" font-weight="700" fill="#334155" font-size="18">
          <text x="44" y="54">CHECKLIST DE AVARIAS - MOTO</text>
          <text x="72" y="250" font-size="13">VISTA LATERAL</text>
          <text x="574" y="250" font-size="13">VISTA SUPERIOR</text>
        </g>
        <g transform="translate(58 96)">
          <ellipse cx="225" cy="267" rx="205" ry="17" fill="#0f172a" opacity=".12"/>
          <circle cx="100" cy="230" r="55" fill="url(#motoTire)" stroke="#111827" stroke-width="7"/><circle cx="100" cy="230" r="21" fill="#e2e8f0" stroke="#111827" stroke-width="4"/>
          <circle cx="350" cy="230" r="55" fill="url(#motoTire)" stroke="#111827" stroke-width="7"/><circle cx="350" cy="230" r="21" fill="#e2e8f0" stroke="#111827" stroke-width="4"/>
          <path d="M130 218h72l70-78h76l44 78" fill="none" stroke="#334155" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M224 202l-35-66h65l22 60m72-60l56-48" fill="none" stroke="#64748b" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M250 132c36-24 91-24 124 0l-31 38H222z" fill="url(#motoBlue)" stroke="#0f172a" stroke-width="5" stroke-linejoin="round"/>
          <path d="M320 100h56l22 22h-76z" fill="#e2e8f0" stroke="#0f172a" stroke-width="4"/>
          <path d="M396 88h48" stroke="#0f172a" stroke-width="8" stroke-linecap="round"/>
        </g>
        <g transform="translate(544 108)">
          <path d="M82 214c-30-62-16-147 46-185 77 18 129 18 204 0 60 38 75 123 44 185-99 20-196 20-294 0z" fill="#f8fafc" stroke="#111827" stroke-width="6"/>
          <path d="M149 74h160l31 73-31 72H149l-31-72z" fill="url(#motoBlue)" opacity=".78" stroke="#475569" stroke-width="5"/>
          <path d="M185 47h88m-112 205h136" stroke="#111827" stroke-width="8" stroke-linecap="round"/>
          <circle cx="111" cy="130" r="18" fill="url(#motoTire)" stroke="#111827" stroke-width="5"/><circle cx="347" cy="130" r="18" fill="url(#motoTire)" stroke="#111827" stroke-width="5"/>
        </g>
        <g stroke="#64748b" stroke-width="3" fill="none" opacity=".82">
          <path d="M150 152H72"/><path d="M400 152h84"/><path d="M282 96V70"/><path d="M675 132h-72"/><path d="M813 132h50"/><path d="M723 318v54"/>
        </g>
        <g fill="#fff" stroke="#64748b" stroke-width="3"><circle cx="72" cy="152" r="9"/><circle cx="484" cy="152" r="9"/><circle cx="282" cy="70" r="9"/><circle cx="603" cy="132" r="9"/><circle cx="863" cy="132" r="9"/><circle cx="723" cy="372" r="9"/></g>
      </svg>`;
    }
    if (String(type || "") === "caminhao") {
      return `<svg viewBox="0 0 920 520" role="img" aria-label="Prancha técnica de caminhão para checklist de avarias">
        <defs>
          <linearGradient id="truckPanel" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#e5e7eb"/></linearGradient>
          <linearGradient id="truckBody" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f8fafc"/><stop offset="45%" stop-color="#dbeafe"/><stop offset="100%" stop-color="#94a3b8"/></linearGradient>
          <linearGradient id="truckCabPaint" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#eff6ff"/><stop offset="50%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0369a1"/></linearGradient>
          <radialGradient id="truckTireTech" cx="50%" cy="50%" r="55%"><stop offset="0%" stop-color="#f8fafc"/><stop offset="44%" stop-color="#334155"/><stop offset="100%" stop-color="#020617"/></radialGradient>
          <filter id="truckPaperShadow" x="-5%" y="-5%" width="110%" height="120%"><feDropShadow dx="0" dy="10" stdDeviation="8" flood-color="#000" flood-opacity=".18"/></filter>
        </defs>
        <rect x="18" y="18" width="884" height="484" rx="18" fill="url(#truckPanel)" stroke="#cbd5e1" stroke-width="4" filter="url(#truckPaperShadow)"/>
        <g font-family="Arial, sans-serif" font-weight="700" fill="#334155" font-size="18">
          <text x="44" y="54">CHECKLIST DE AVARIAS - CAMINHÃO / MUNCK</text>
          <text x="62" y="244" font-size="13">LATERAL ESQUERDA</text>
          <text x="538" y="244" font-size="13">LATERAL DIREITA</text>
          <text x="130" y="84" font-size="13">VISTA SUPERIOR</text>
          <text x="570" y="84" font-size="13">FRENTE / TRASEIRA</text>
        </g>
        <g transform="translate(72 92)">
          <rect x="40" y="28" width="312" height="86" rx="8" fill="url(#truckBody)" stroke="#111827" stroke-width="6"/>
          <rect x="352" y="34" width="88" height="76" rx="8" fill="url(#truckCabPaint)" stroke="#111827" stroke-width="6"/>
          <rect x="375" y="48" width="42" height="38" rx="4" fill="#e0f2fe" stroke="#334155" stroke-width="4"/>
          <path d="M58 50h274M58 86h274" stroke="#94a3b8" stroke-width="4"/>
          <circle cx="92" cy="128" r="16" fill="url(#truckTireTech)" stroke="#111827" stroke-width="5"/><circle cx="302" cy="128" r="16" fill="url(#truckTireTech)" stroke="#111827" stroke-width="5"/>
        </g>
        <g transform="translate(552 104)">
          <rect x="0" y="0" width="120" height="120" rx="12" fill="url(#truckCabPaint)" stroke="#111827" stroke-width="6"/>
          <rect x="24" y="18" width="72" height="42" rx="5" fill="#e0f2fe" stroke="#334155" stroke-width="4"/>
          <circle cx="22" cy="132" r="17" fill="url(#truckTireTech)" stroke="#111827" stroke-width="5"/><circle cx="98" cy="132" r="17" fill="url(#truckTireTech)" stroke="#111827" stroke-width="5"/>
          <rect x="172" y="0" width="120" height="120" rx="8" fill="url(#truckBody)" stroke="#111827" stroke-width="6"/>
          <path d="M186 18h92M186 56h92M186 94h92" stroke="#94a3b8" stroke-width="4"/>
        </g>
        <g transform="translate(60 274)">
          <ellipse cx="216" cy="162" rx="206" ry="18" fill="#0f172a" opacity=".12"/>
          <rect x="20" y="50" width="270" height="94" rx="7" fill="url(#truckBody)" stroke="#111827" stroke-width="6"/>
          <path d="M290 66h95l48 44v34H290z" fill="url(#truckCabPaint)" stroke="#111827" stroke-width="6" stroke-linejoin="round"/>
          <path d="M318 78h48l28 30h-76z" fill="#e0f2fe" stroke="#334155" stroke-width="4"/>
          <path d="M34 78h240M34 112h240" stroke="#94a3b8" stroke-width="4"/>
          <circle cx="94" cy="152" r="29" fill="url(#truckTireTech)" stroke="#111827" stroke-width="7"/><circle cx="244" cy="152" r="29" fill="url(#truckTireTech)" stroke="#111827" stroke-width="7"/><circle cx="374" cy="152" r="29" fill="url(#truckTireTech)" stroke="#111827" stroke-width="7"/>
        </g>
        <g transform="translate(506 274)">
          <ellipse cx="216" cy="162" rx="206" ry="18" fill="#0f172a" opacity=".12"/>
          <path d="M20 66h95l48 44v34H20z" fill="url(#truckCabPaint)" stroke="#111827" stroke-width="6" stroke-linejoin="round"/>
          <rect x="163" y="50" width="270" height="94" rx="7" fill="url(#truckBody)" stroke="#111827" stroke-width="6"/>
          <path d="M48 78h48l28 30H48z" fill="#e0f2fe" stroke="#334155" stroke-width="4"/>
          <path d="M182 78h232M182 112h232" stroke="#94a3b8" stroke-width="4"/>
          <circle cx="78" cy="152" r="29" fill="url(#truckTireTech)" stroke="#111827" stroke-width="7"/><circle cx="210" cy="152" r="29" fill="url(#truckTireTech)" stroke="#111827" stroke-width="7"/><circle cx="360" cy="152" r="29" fill="url(#truckTireTech)" stroke="#111827" stroke-width="7"/>
        </g>
        <g stroke="#64748b" stroke-width="3" fill="none" opacity=".82"><path d="M112 365H48"/><path d="M433 365h48"/><path d="M742 330V286"/><path d="M696 137h72"/><path d="M248 118V82"/></g>
        <g fill="#fff" stroke="#64748b" stroke-width="3"><circle cx="48" cy="365" r="9"/><circle cx="481" cy="365" r="9"/><circle cx="742" cy="286" r="9"/><circle cx="768" cy="137" r="9"/><circle cx="248" cy="82" r="9"/></g>
      </svg>`;
    }
    return `<svg viewBox="0 0 920 520" role="img" aria-label="Prancha técnica de automóvel para checklist de avarias">
      <defs>
        <linearGradient id="carPanel" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#e5e7eb"/></linearGradient>
        <linearGradient id="carBodyTech" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f8fafc"/><stop offset="48%" stop-color="#bfdbfe"/><stop offset="100%" stop-color="#64748b"/></linearGradient>
        <linearGradient id="carGlassTech" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#e0f2fe"/><stop offset="100%" stop-color="#64748b"/></linearGradient>
        <radialGradient id="carTireTech" cx="50%" cy="50%" r="55%"><stop offset="0%" stop-color="#f8fafc"/><stop offset="43%" stop-color="#475569"/><stop offset="100%" stop-color="#020617"/></radialGradient>
        <filter id="carPaperShadow" x="-5%" y="-5%" width="110%" height="120%"><feDropShadow dx="0" dy="10" stdDeviation="8" flood-color="#000" flood-opacity=".18"/></filter>
      </defs>
      <rect x="18" y="18" width="884" height="484" rx="18" fill="url(#carPanel)" stroke="#cbd5e1" stroke-width="4" filter="url(#carPaperShadow)"/>
      <g font-family="Arial, sans-serif" font-weight="700" fill="#334155" font-size="18">
        <text x="44" y="54">CHECKLIST DE AVARIAS - AUTOMÓVEL / UTILITÁRIO</text>
        <text x="76" y="244" font-size="13">LATERAL ESQUERDA</text>
        <text x="532" y="244" font-size="13">LATERAL DIREITA</text>
        <text x="146" y="84" font-size="13">VISTA SUPERIOR</text>
        <text x="594" y="84" font-size="13">FRENTE / TRASEIRA</text>
      </g>
      <g transform="translate(84 92)">
        <path d="M44 83c22-37 65-56 128-56h134c62 0 109 19 133 56 13 52 10 94-10 127-118 24-260 24-376 0-19-35-21-77-9-127z" fill="url(#carBodyTech)" stroke="#111827" stroke-width="6"/>
        <path d="M125 52h230l38 60H90z" fill="url(#carGlassTech)" opacity=".78" stroke="#334155" stroke-width="5"/>
        <path d="M100 151h282M142 52v156M336 52v156" stroke="#94a3b8" stroke-width="4"/>
        <rect x="62" y="26" width="34" height="30" rx="6" fill="#e5e7eb" stroke="#334155" stroke-width="4"/><rect x="382" y="26" width="34" height="30" rx="6" fill="#e5e7eb" stroke="#334155" stroke-width="4"/>
      </g>
      <g transform="translate(570 102)">
        <path d="M24 26c36-18 142-18 178 0 20 30 23 78 10 118-42 17-156 17-198 0-13-40-10-88 10-118z" fill="url(#carBodyTech)" stroke="#111827" stroke-width="6"/>
        <path d="M52 43h122l15 58H37z" fill="url(#carGlassTech)" stroke="#334155" stroke-width="5"/>
        <rect x="26" y="118" width="37" height="16" rx="6" fill="#fef08a"/><rect x="162" y="118" width="37" height="16" rx="6" fill="#fef08a"/>
        <path d="M86 154h54" stroke="#334155" stroke-width="5" stroke-linecap="round"/>
        <path d="M280 26c36-18 142-18 178 0 20 30 23 78 10 118-42 17-156 17-198 0-13-40-10-88 10-118z" fill="url(#carBodyTech)" stroke="#111827" stroke-width="6" transform="translate(-18 0)"/>
        <path d="M314 45h122l13 46H301z" fill="#e2e8f0" stroke="#334155" stroke-width="5"/>
        <rect x="284" y="121" width="37" height="16" rx="6" fill="#fecaca"/><rect x="420" y="121" width="37" height="16" rx="6" fill="#fecaca"/>
      </g>
      <g transform="translate(60 284)">
        <ellipse cx="219" cy="147" rx="198" ry="17" fill="#0f172a" opacity=".12"/>
        <path d="M42 98c18-55 86-78 158-78h132c78 0 128 30 160 78l18 40c-24 17-73 26-137 26H166c-66 0-114-9-140-26z" fill="url(#carBodyTech)" stroke="#111827" stroke-width="6" stroke-linejoin="round"/>
        <path d="M158 50h244l52 55H107z" fill="url(#carGlassTech)" opacity=".80" stroke="#334155" stroke-width="5" stroke-linejoin="round"/>
        <path d="M74 112h408M185 50l-35 54M335 50l35 54" stroke="#94a3b8" stroke-width="4"/>
        <circle cx="160" cy="166" r="31" fill="url(#carTireTech)" stroke="#111827" stroke-width="7"/><circle cx="402" cy="166" r="31" fill="url(#carTireTech)" stroke="#111827" stroke-width="7"/>
      </g>
      <g transform="translate(506 284)">
        <ellipse cx="219" cy="147" rx="198" ry="17" fill="#0f172a" opacity=".12"/>
        <path d="M42 98c18-55 86-78 158-78h132c78 0 128 30 160 78l18 40c-24 17-73 26-137 26H166c-66 0-114-9-140-26z" fill="url(#carBodyTech)" stroke="#111827" stroke-width="6" stroke-linejoin="round"/>
        <path d="M158 50h244l52 55H107z" fill="url(#carGlassTech)" opacity=".80" stroke="#334155" stroke-width="5" stroke-linejoin="round"/>
        <path d="M74 112h408M185 50l-35 54M335 50l35 54" stroke="#94a3b8" stroke-width="4"/>
        <circle cx="160" cy="166" r="31" fill="url(#carTireTech)" stroke="#111827" stroke-width="7"/><circle cx="402" cy="166" r="31" fill="url(#carTireTech)" stroke="#111827" stroke-width="7"/>
      </g>
      <g stroke="#64748b" stroke-width="3" fill="none" opacity=".82">
        <path d="M120 386H52"/><path d="M510 386h54"/><path d="M736 120V82"/><path d="M254 142V82"/><path d="M824 154h54"/><path d="M716 448v34"/>
      </g>
      <g fill="#fff" stroke="#64748b" stroke-width="3"><circle cx="52" cy="386" r="9"/><circle cx="564" cy="386" r="9"/><circle cx="736" cy="82" r="9"/><circle cx="254" cy="82" r="9"/><circle cx="878" cy="154" r="9"/><circle cx="716" cy="482" r="9"/></g>
    </svg>`;
  }

  function renderDamageEditor() {
    const editor = $("damageSelectedEditor");
    if (!editor) return;
    const part = DAMAGE_PARTS.find((item) => item.key === activeDamagePartKey);
    if (!part || !selectedDamageParts.has(activeDamagePartKey)) {
      editor.classList.add("hidden");
      editor.innerHTML = "";
      return;
    }
    editor.classList.remove("hidden");
    editor.innerHTML = `
      <div class="damage-editor-head">
        <b>Avaria em: ${esc(part.label)}</b>
        <button class="btn mini" type="button" data-action="close">Fechar</button>
      </div>
      <textarea id="damagePartNoteInput" placeholder="Descreva a avaria desta parte. Ex.: riscado, amassado, quebrado, vazando, pneu murcho.">${esc(selectedDamageNotes[part.key] || "")}</textarea>
      <div class="actions">
        <button class="btn good" type="button" data-action="save">Salvar descrição</button>
        <button class="btn danger" type="button" data-action="remove">Remover marcação</button>
      </div>`;
    const input = $("damagePartNoteInput");
    if (input) {
      input.oninput = () => {
        selectedDamageNotes[part.key] = input.value.trim();
        updateDamageSummary();
      };
      setTimeout(() => input.focus(), 80);
    }
    editor.querySelectorAll("[data-action]").forEach((btn) => {
      btn.onclick = () => {
        const action = btn.getAttribute("data-action");
        if (action === "save" && input) selectedDamageNotes[part.key] = input.value.trim();
        if (action === "remove") {
          selectedDamageParts.delete(part.key);
          delete selectedDamageNotes[part.key];
          activeDamagePartKey = "";
          setupDamageDiagram();
        }
        if (action === "close" || action === "save") {
          activeDamagePartKey = "";
          renderDamageEditor();
        }
        updateDamageSummary();
      };
    });
  }

  function setupDamageDiagram() {
    const box = $("damageDiagram");
    if (!box) return;
    const type = $("damageVehicleType") ? $("damageVehicleType").value : "carro";
    const parts = damagePartsForType(type);
    box.className = "damage-diagram damage-diagram-visual damage-type-" + String(type || "carro");
    box.innerHTML = `
      <div class="damage-vehicle-svg">${damageVehicleSvg(type)}</div>
      <div class="damage-zone-layer">
        ${parts.map((part) => `<button class="damage-zone damage-part damage-zone-${esc(part.key)}${selectedDamageParts.has(part.key) ? " selected" : ""}" type="button" data-part="${esc(part.key)}" aria-pressed="${selectedDamageParts.has(part.key) ? "true" : "false"}">${esc(part.label)}</button>`).join("")}
      </div>`;
    box.onclick = (event) => {
      const btn = event.target && event.target.closest && event.target.closest(".damage-part");
      if (!btn) return;
      const key = btn.getAttribute("data-part");
      if (!key) return;
      if (selectedDamageParts.has(key)) {
        selectedDamageParts.delete(key);
        delete selectedDamageNotes[key];
        if (activeDamagePartKey === key) activeDamagePartKey = "";
      } else {
        selectedDamageParts.add(key);
        activeDamagePartKey = key;
        const retiradaSelect = stageSelect("retirada");
        if (retiradaSelect && retiradaSelect.value === "pendente") setProofStageValue("retirada", "avaria", true);
      }
      setupDamageDiagram();
      renderDamageEditor();
      updateDamageSummary();
    };
    if ($("damageVehicleType") && $("damageVehicleType").dataset.boundDamageType !== "true") {
      $("damageVehicleType").dataset.boundDamageType = "true";
      $("damageVehicleType").onchange = () => {
        setupDamageDiagram();
        renderDamageEditor();
      };
    }
    renderDamageEditor();
    updateDamageSummary();
  }

  function setupAccessoryChecklist() {
    const box = $("proofAccessoriesGrid");
    if (!box) return;
    box.innerHTML = ACCESSORY_GROUPS.map((group) => `
      <div class="proof-accessory-group">
        <h3>${esc(group.title)}</h3>
        ${group.items.map(([key, label]) => `
          <div class="proof-accessory-row">
            <span>${esc(label)}</span>
            <select id="proofAccessory_${esc(key)}" aria-label="${esc(label)}">
              <option value="">Não informado</option>
              <option value="sim">S</option>
              <option value="nao">N</option>
              <option value="avaria">A</option>
            </select>
          </div>
        `).join("")}
      </div>
    `).join("");
  }

  function accessoryChecklistPayload() {
    return ACCESSORY_GROUPS.map((group) => ({
      title: group.title,
      items: group.items.map(([key, label]) => {
        const value = $("proofAccessory_" + key) ? $("proofAccessory_" + key).value : "";
        return { key, label, value, shortLabel: ACCESSORY_STATUS_LABELS[value] || "" };
      })
    }));
  }

  function technicalInspectionPayload() {
    return {
      fuelLevel: $("proofFuelLevel") ? $("proofFuelLevel").value : "",
      odometer: $("proofOdometer") ? $("proofOdometer").value.trim() : "",
      tireCondition: $("proofTireCondition") ? $("proofTireCondition").value : "",
      keyDocument: $("proofKeyDocument") ? $("proofKeyDocument").value : "",
      vehicleLoaded: $("proofVehicleLoaded") ? $("proofVehicleLoaded").value : "",
      easyRemoval: $("proofEasyRemoval") ? $("proofEasyRemoval").value : "",
      technicalNotes: $("proofVehicleTechnicalNotes") ? $("proofVehicleTechnicalNotes").value.trim() : "",
      pickupResponsible: {
        name: $("proofPickupResponsibleName") ? $("proofPickupResponsibleName").value.trim() : "",
        document: $("proofPickupResponsibleDoc") ? $("proofPickupResponsibleDoc").value.trim() : ""
      },
      deliveryResponsible: {
        name: $("proofDeliveryResponsibleName") ? $("proofDeliveryResponsibleName").value.trim() : "",
        document: $("proofDeliveryResponsibleDoc") ? $("proofDeliveryResponsibleDoc").value.trim() : ""
      },
      accessories: accessoryChecklistPayload()
    };
  }

  function damageAssessmentPayload() {
    const vehicleType = $("damageVehicleType") ? $("damageVehicleType").value : "";
    const details = $("proofDamageDetails") ? $("proofDamageDetails").value.trim() : "";
    const parts = Array.from(selectedDamageParts).map((key) => {
      const item = DAMAGE_PARTS.find((part) => part.key === key);
      return { key, label: item && item.label || key, note: selectedDamageNotes[key] || "" };
    });
    return {
      vehicleType,
      parts,
      details,
      updatedAt: new Date().toISOString(),
      updatedBy: state.user && state.user.uid || ""
    };
  }

  function resetDamageDiagram() {
    selectedDamageParts = new Set();
    selectedDamageNotes = {};
    activeDamagePartKey = "";
    document.querySelectorAll(".damage-part.selected").forEach((btn) => btn.classList.remove("selected"));
    setupDamageDiagram();
    updateDamageSummary();
  }

  function fieldValue(id, value) {
    if ($(id)) $(id).value = value == null ? "" : value;
  }

  function loadDamageAssessmentPayload(damage) {
    damage = damage || {};
    const parts = Array.isArray(damage.parts) ? damage.parts : [];
    selectedDamageParts = new Set(parts.map((part) => part && part.key).filter(Boolean));
    selectedDamageNotes = {};
    parts.forEach((part) => {
      if (part && part.key && part.note) selectedDamageNotes[part.key] = part.note;
    });
    activeDamagePartKey = "";
    if ($("damageVehicleType")) $("damageVehicleType").value = damage.vehicleType || $("damageVehicleType").value || "carro";
    fieldValue("proofDamageDetails", damage.details || "");
    setupDamageDiagram();
  }

  function loadProofFormForCall(callId, sourceCall) {
    const call = sourceCall || state.calls[callId];
    if (!call) return;
    lastLoadedProofCallId = callId || "";
    const checklist = call.proofChecklist || {};
    PROOF_STAGES.forEach((stage) => {
      const cfg = PROOF_STAGE_FIELDS[stage] || {};
      const row = checklist[stage] || {};
      setProofStageValue(stage, row.status || "pendente", false);
      if (cfg.justification) fieldValue(cfg.justification, row.justificativa || "");
    });
    fieldValue("proofChecklistNotes", checklist.notes || "");
    const inspection = checklist.vehicleInspection || {};
    fieldValue("proofFuelLevel", inspection.fuelLevel || "");
    fieldValue("proofOdometer", inspection.odometer || "");
    fieldValue("proofTireCondition", inspection.tireCondition || "");
    fieldValue("proofKeyDocument", inspection.keyDocument || "");
    fieldValue("proofVehicleLoaded", inspection.vehicleLoaded || "");
    fieldValue("proofEasyRemoval", inspection.easyRemoval || "");
    fieldValue("proofVehicleTechnicalNotes", inspection.technicalNotes || "");
    fieldValue("proofPickupResponsibleName", inspection.pickupResponsible && inspection.pickupResponsible.name || "");
    fieldValue("proofPickupResponsibleDoc", inspection.pickupResponsible && inspection.pickupResponsible.document || "");
    fieldValue("proofDeliveryResponsibleName", inspection.deliveryResponsible && inspection.deliveryResponsible.name || "");
    fieldValue("proofDeliveryResponsibleDoc", inspection.deliveryResponsible && inspection.deliveryResponsible.document || "");
    loadDamageAssessmentPayload(checklist.damageAssessment || call.damageAssessment || {});
    setProofSubmitStatus("Checklist carregado. Toque nas etapas que esta registrando agora; o que ja foi salvo fica preservado.", "info", false);
  }

  function normalizeDriverProfile(user, data) {
    const profile = Object.assign({}, data || {}, {
      uid: user.uid,
      email: String(user.email || "").toLowerCase(),
      role: normalizedRole(data && data.role || "driver") || "driver",
      active: data && data.active !== false
    });
    if (!isDriverRole(profile.role)) {
      throw new Error("Este login existe, mas não está marcado como motorista.");
    }
    if (profile.active === false) {
      throw new Error("Seu usuário não está ativo no cadastro da JM Guinchos.");
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
    throw new Error("Seu motorista existe no Auth, mas não está liberado em driverAccess. Recrie/atualize o motorista no jm.html depois de publicar as regras novas.");
  }

  function startListeners() {
    stopListeners();
    unsubscribers.push(db.collection("vehicles").onSnapshot((snap) => {
      const rows = {};
      snap.forEach((doc) => { rows[doc.id] = { id: doc.id, ...doc.data() }; });
      state.vehicles = rows;
      scheduleRender("vehicles");
    }));
    unsubscribers.push(db.collection("calls").where("driverId", "==", state.user.uid).onSnapshot((snap) => {
      const rows = {};
      snap.forEach((doc) => { rows[doc.id] = { id: doc.id, ...doc.data() }; });
      state.calls = rows;
      scheduleRender("calls");
    }));
    unsubscribers.push(db.collection("expenses").where("driverId", "==", state.user.uid).onSnapshot((snap) => {
      const rows = {};
      snap.forEach((doc) => { rows[doc.id] = { id: doc.id, ...doc.data() }; });
      state.expenses = rows;
      scheduleRender("expenses");
    }));
    unsubscribers.push(db.collection("settings").doc("integrations").onSnapshot((snap) => {
      state.settings = snap.exists ? snap.data() : {};
      applyMobileGpsVisibility();
      scheduleRender("settings");
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
      applyMobileGpsVisibility();
      setTimeout(() => setupCollapsiblePanels(document, { collapseOnMobile: true, openFirst: 1 }), 80);
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
  $("driverRefreshBtn").onclick = () => render("manual");
  if ($("driverExpenseCall")) $("driverExpenseCall").onchange = syncDriverExpenseContext;
  if ($("driverProofCall")) $("driverProofCall").onchange = () => loadProofFormForCall($("driverProofCall").value);
  if ($("driverStartLocationBtn")) $("driverStartLocationBtn").onclick = startDriverPhoneLocation;
  if ($("driverStopLocationBtn")) $("driverStopLocationBtn").onclick = stopDriverPhoneLocation;

  function activeCalls() {
    return visibleRows(state.calls).filter((c) => !isFinalStatus(c));
  }

  function render(reason) {
    if (state.selectedCallId && !state.calls[state.selectedCallId]) state.selectedCallId = "";
    if (!state.selectedCallId && activeCalls()[0]) state.selectedCallId = activeCalls()[0].id;
    renderCalls();
    renderExpenseSelects();
    scheduleMapRender();
  }

  function renderCalls() {
    const calls = activeCalls().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    $("driverCallsBox").innerHTML = calls.length ? calls.map((call) => {
      const vehicle = state.vehicles[call.vehicleId] || {};
      const url = call.routeExternalUrl || call.routeUrl || mapsRouteUrl(call, vehicle);
      const km = routeKm(call, vehicle);
      const metric = call.routeDistanceText || call.routeMetrics && call.routeMetrics.fullRoute && call.routeMetrics.fullRoute.distanceText || (km ? km.toFixed(1).replace(".", ",") + " km estimados" : "aguardando coordenadas");
      const routeBadge = call.routePrecision === "osrm_openstreetmap" || call.routeMetrics && call.routeMetrics.fullRoute && call.routeMetrics.fullRoute.isPrecise ? `<span class="badge ok">Rota por ruas</span>` : `<span class="badge warn">Rota estimada/fallback</span>`;
      const proof = proofBadge(call);
      return `<div class="card" style="margin-bottom:10px">
        <div class="actions" style="justify-content:space-between">
          <div><b>${esc(call.protocolo || call.id)}</b><br><span class="muted small">${esc(call.cliente || "")} - ${esc(vehicle.placa || "")}</span></div>
          <span class="badge ${statusClass(call)}">${esc(statusLabel(call))}</span>
        </div>
        <p class="small"><b>Origem:</b> ${esc(call.origem?.label || call.originLabel || "-")}<br><b>Destino:</b> ${esc(call.destino?.label || call.destLabel || "-")}<br><b>Rota:</b> ${esc(metric)} ${routeBadge} ${proof}<br><b>Acionamento:</b> ${esc(call.source || "Particular")}${call.insurance ? " · " + esc(call.insurance) : ""}${call.insuranceProtocol ? " · Prot. " + esc(call.insuranceProtocol) : ""}<br><b>Veículo cliente:</b> ${esc(call.customerPlate || "-")} ${call.customerVehicle ? "· " + esc(call.customerVehicle) : ""}</p>
        <div class="actions">
          <button class="btn primary" onclick="JM.motorista.acceptCall('${esc(call.id)}')">Aceitar chamado</button>
          <button class="btn primary" onclick="JM.motorista.setStatus('${esc(call.id)}','motorista_a_caminho')">Iniciar chamado</button>
          <button class="btn good" onclick="JM.motorista.openRouteForCall('${esc(call.id)}')">Ver rota no painel</button>
          <button class="btn good" onclick="JM.motorista.startRouteForCall('${esc(call.id)}')">Iniciar rota</button>
          ${url ? `<button class="btn" onclick="JM.motorista.openExternalRouteForCall('${esc(call.id)}')">Abrir Maps/Waze</button>` : ""}
          <button class="btn" onclick="JM.motorista.setStatus('${esc(call.id)}','motorista_no_local')">No local</button>
          <button class="btn" onclick="JM.motorista.setStatus('${esc(call.id)}','veiculo_carregado')">Carregado</button>
          <button class="btn" onclick="JM.motorista.setStatus('${esc(call.id)}','em_transporte')">Em transporte</button>
          <button class="btn" onclick="JM.motorista.setStatus('${esc(call.id)}','entregue')">Entregue</button>
          ${isMobileGpsEnabled() ? `<button class="btn warn" data-mobile-gps-only onclick="JM.motorista.startLocationForCall('${esc(call.id)}')">Ligar GPS do celular</button>` : ""}
          <button class="btn good" onclick="JM.motorista.setStatus('${esc(call.id)}','finalizado')">Finalizar</button>
        </div>
      </div>`;
    }).join("") : `<p class="muted">Nenhum chamado vinculado ao seu usuário.</p>`;
  }

  function renderExpenseSelects() {
    const currentCall = $("driverExpenseCall") && $("driverExpenseCall").value || "";
    const currentVehicle = $("driverExpenseVehicle") && $("driverExpenseVehicle").value || "";
    const currentReportCall = $("driverReportCall") && $("driverReportCall").value || "";
    const currentProofCall = $("driverProofCall") && $("driverProofCall").value || "";
    const currentLocationCall = $("driverLocationCall") && $("driverLocationCall").value || "";
    const currentLocationVehicle = $("driverLocationVehicle") && $("driverLocationVehicle").value || "";
    const calls = activeCalls();
    const sig = optionSignature(calls, state.vehicles);
    const callOptions = calls.map((c) => `<option value="${esc(c.id)}">${esc(c.protocolo || c.cliente || c.id)}</option>`).join("");
    const callHtmlEmpty = `<option value="">Sem chamado</option>` + callOptions;
    const callHtmlSelect = `<option value="">Selecione</option>` + callOptions;
    const vehicleHtml = `<option value="">Selecione</option>` + visibleRows(state.vehicles).map((v) => `<option value="${esc(v.id)}">${esc(v.placa || v.id)}</option>`).join("");

    setSelectOptionsStable($("driverExpenseCall"), callHtmlEmpty, currentCall);
    setSelectOptionsStable($("driverReportCall"), callHtmlSelect, currentReportCall);
    setSelectOptionsStable($("driverProofCall"), callHtmlSelect, currentProofCall);
    setSelectOptionsStable($("driverLocationCall"), callHtmlSelect, currentLocationCall);
    setSelectOptionsStable($("driverLocationVehicle"), vehicleHtml, currentLocationVehicle || selectedCallVehicleId());
    setSelectOptionsStable($("driverExpenseVehicle"), vehicleHtml, currentVehicle);

    lastSelectSignature = sig;
    if ($("driverProofCall") && $("driverProofCall").value && $("driverProofCall").value !== lastLoadedProofCallId) {
      loadProofFormForCall($("driverProofCall").value);
    }
    syncDriverExpenseContext();
  }

  function callRouteUrl(call) {
    if (!call) return "";
    const vehicle = state.vehicles[call.vehicleId] || {};
    return call.routeExternalUrl || call.routeUrl || mapsRouteUrl(call, vehicle) || "";
  }

  function openRouteForCall(id) {
    focusCallRoute(id, true);
  }

  function openExternalRouteForCall(id) {
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado para abrir rota.", "danger");
    const url = callRouteUrl(call);
    if (!url) return toast("Este chamado ainda não tem origem/destino suficientes para abrir rota.", "danger");
    window.open(url, "_blank", "noopener");
    toast("Rota aberta no aplicativo de mapas.", "ok");
  }

  async function acceptCall(id) {
    focusCallRoute(id, false);
    await setStatus(id, "despachado");
    toast("Chamado aceito. Inicie a rota quando estiver pronto para deslocar.", "ok");
  }

  async function startRouteForCall(id) {
    const call = state.calls[id];
    if (!call) return toast("Chamado não encontrado para iniciar rota.", "danger");
    focusCallRoute(id, true);
    if (isMobileGpsEnabled()) startDriverPhoneLocation(id).catch((err) => setDriverRouteStatus("Rota iniciada, mas o GPS do celular não ligou: " + (err && err.message || "falha de permissão"), "danger"));
    await setStatus(id, "motorista_a_caminho");
  }

  function setDriverLocationStatus(message, type) {
    const box = $("driverLocationStatus");
    if (!box) return;
    box.textContent = message;
    box.className = "wide small " + (type || "muted");
  }

  async function stopDriverPhoneLocation() {
    if (driverLocationWatchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(driverLocationWatchId);
    }
    driverLocationWatchId = null;
    try {
      const callId = $("driverLocationCall") && $("driverLocationCall").value;
      const call = callId && state.calls[callId];
      const vehicleId = (call && (call.vehicleId || call.vehicle || call.truckId || "")) || ($("driverLocationVehicle") && $("driverLocationVehicle").value) || "";
      const now = new Date().toISOString();
      if (callId) await db.collection("calls").doc(callId).set({ phoneLocationActive: false, phoneLocationStoppedAt: now, updatedAt: now }, { merge: true });
      if (isMobileGpsRealtime()) {
        const gps = activeMobileGpsSettings();
        const rtdb = getRealtimeDb && getRealtimeDb(gps.databaseURL);
        if (rtdb) {
          const p = state.driverLivePoint || {};
          const lat = Number(p.lat);
          const lng = Number(p.lng);
          const payload = {
            lat: Number.isFinite(lat) ? lat : 0,
            lng: Number.isFinite(lng) ? lng : 0,
            driverId: state.user && state.user.uid || "",
            driverName: state.profile && state.profile.nome || state.user && state.user.email || "",
            driverEmail: state.user && state.user.email || "",
            vehicleId: vehicleId ? rtdbKey(vehicleId) : "",
            rawVehicleId: vehicleId || "",
            callId: callId ? rtdbKey(callId) : "",
            rawCallId: callId || "",
            updatedAt: now,
            capturedAt: p.capturedAt || now,
            active: false,
            source: "driver_phone_realtime_database"
          };
          const updates = {};
          if (callId) updates["mobileGps/calls/" + rtdbKey(callId)] = payload;
          if (vehicleId) updates["mobileGps/vehicles/" + rtdbKey(vehicleId)] = payload;
          updates["mobileGps/drivers/" + rtdbKey(state.user && state.user.uid || "driver")] = payload;
          await rtdb.ref().update(updates);
        }
      }
    } catch (err) {
      console.warn("Falha ao encerrar GPS do celular", err);
    }
    setDriverLocationStatus("Localização do celular desligada.", "muted");
  }

  async function saveDriverLocationPoint(callId, pos, options) {
    options = options || {};
    if (!isMobileGpsEnabled()) {
      throw new Error("Módulo de localização por celular desativado no superadmin.");
    }
    const call = callId ? state.calls[callId] || {} : {};
    const vehicleId = options.vehicleId || call.vehicleId || call.vehicle || call.truckId || "";
    if (!callId && !vehicleId) throw new Error("Selecione um chamado ou um veículo para ligar o GPS do celular.");
    if (!shouldPersistDriverGps(callId, pos, !!options.force, vehicleId)) {
      return null;
    }
    const rtdbCallId = callId ? rtdbKey(callId) : "";
    const rtdbVehicleId = vehicleId ? rtdbKey(vehicleId) : "";
    const point = {
      lat: Number(pos.coords.latitude),
      lng: Number(pos.coords.longitude),
      accuracy: pos.coords.accuracy || null,
      altitude: pos.coords.altitude || null,
      heading: pos.coords.heading || null,
      speed: pos.coords.speed || null,
      source: isMobileGpsRealtime() ? "driver_phone_realtime_database" : "driver_phone_geolocation",
      capturedAt: new Date().toISOString(),
      driverId: state.user.uid,
      driverName: state.profile.nome || state.user.email,
      callId: callId || "",
      vehicleId
    };
    lastDriverPhoneWrite = { callId: callId || vehicleId || "driver", at: Date.now(), lat: point.lat, lng: point.lng };
    if (callId) state.selectedCallId = callId;
    state.driverLivePoint = point;
    scheduleMapRender(80);
    if (callId) {
      setDriverRouteStatus("GPS do celular atualizado. A rota interna foi recalculada com a posição viva do motorista.", "ok");
    }

    if (isMobileGpsRealtime()) {
      const gps = activeMobileGpsSettings();
      const rtdb = getRealtimeDb && getRealtimeDb(gps.databaseURL);
      if (!rtdb) throw new Error("Realtime Database não configurado. Informe databaseURL no superadmin ou use modo Firestore.");
      const payload = {
        point,
        lat: point.lat,
        lng: point.lng,
        accuracy: point.accuracy,
        heading: point.heading,
        speed: point.speed,
        capturedAt: point.capturedAt,
        updatedAt: point.capturedAt,
        active: true,
        callId: rtdbCallId,
        rawCallId: callId || "",
        vehicleId: rtdbVehicleId,
        rawVehicleId: vehicleId,
        driverId: state.user.uid,
        driverName: state.profile.nome || state.user.email,
        driverEmail: state.user.email || ""
      };
      const updates = {};
      if (rtdbCallId) updates["mobileGps/calls/" + rtdbCallId] = payload;
      if (rtdbVehicleId) updates["mobileGps/vehicles/" + rtdbVehicleId] = payload;
      updates["mobileGps/drivers/" + rtdbKey(state.user.uid)] = payload;
      await rtdb.ref().update(updates);
      if (options.force && callId) {
        await db.collection("calls").doc(callId).set({
          phoneLocationActive: true,
          phoneLocationBackend: "realtime_database",
          gpsSource: "driver_phone_rtdb",
          phoneLocationStartedAt: point.capturedAt,
          phoneLocationUpdatedAt: point.capturedAt,
          activePhoneGpsVehicleId: vehicleId || "",
          updatedAt: point.capturedAt
        }, { merge: true });
      }
      const vehicleLabel = vehicleId ? " · RTDB do veículo atualizado" : " · somente ponto do motorista";
      const callLabel = callId ? " · chamado vinculado" : " · sem chamado ativo";
      setDriverLocationStatus("Localização ativa via Realtime DB: " + point.lat.toFixed(6) + ", " + point.lng.toFixed(6) + " · precisão " + Math.round(point.accuracy || 0) + "m" + vehicleLabel + callLabel, vehicleId ? "ok" : "warn");
      return point;
    }

    const callPayload = {
      driverPhoneLocation: point,
      mobileLocation: point,
      phoneLocationActive: true,
      phoneLocationBackend: "firestore",
      phoneLocationUpdatedAt: point.capturedAt,
      gpsSource: "driver_phone",
      updatedAt: point.capturedAt
    };

    if (callId) await db.collection("calls").doc(callId).set(callPayload, { merge: true });

    if (vehicleId) {
      try {
        await db.collection("vehicles").doc(vehicleId).set({
          location: point,
          mobileLocation: point,
          driverPhoneLocation: point,
          gpsSource: "driver_phone",
          trackerStatus: "GPS celular motorista",
          lastPhoneGpsAt: point.capturedAt,
          lastTrackerAt: point.capturedAt,
          activeCallId: callId || "",
          activeDriverId: state.user.uid,
          activeDriverName: state.profile.nome || state.user.email,
          updatedAt: point.capturedAt,
          updatedBy: state.user.uid
        }, { merge: true });
      } catch (err) {
        console.warn("GPS do celular foi salvo no chamado, mas o veículo recusou atualização. Publique o firestore.rules da versão atual.", err);
      }
    }

    const vehicleLabel = vehicleId ? " · veículo atualizado" : " · somente ponto do motorista";
    setDriverLocationStatus("Localização ativa: " + point.lat.toFixed(6) + ", " + point.lng.toFixed(6) + " · precisão " + Math.round(point.accuracy || 0) + "m" + vehicleLabel, vehicleId ? "ok" : "warn");
    return point;
  }

  async function startDriverPhoneLocation(callIdOverride) {
    if (!isMobileGpsEnabled()) return toast("Módulo de localização por celular desativado no superadmin.", "danger");
    if (!navigator.geolocation) return toast("Este celular/navegador não liberou geolocalização.", "danger");
    const callId = callIdOverride || $("driverLocationCall") && $("driverLocationCall").value;
    const call = callId && state.calls[callId];
    const vehicleId = (call && (call.vehicleId || call.vehicle || call.truckId || "")) || ($("driverLocationVehicle") && $("driverLocationVehicle").value) || "";
    if (!call && !vehicleId) return toast("Selecione um chamado ativo ou o veículo atual para enviar a localização do celular.", "danger");
    if ($("driverLocationCall")) $("driverLocationCall").value = callId;
    if ($("driverLocationVehicle") && vehicleId) $("driverLocationVehicle").value = vehicleId;
    await stopDriverPhoneLocation();
    setDriverLocationStatus("Solicitando permissão de localização do celular...", "warn");
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        await saveDriverLocationPoint(callId || "", pos, { force: true, vehicleId });
        toast("Localização do celular enviada para a central.", "ok");
      } catch (err) {
        setDriverLocationStatus("Falha ao salvar localização do celular: " + (err && err.message || "permissão negada"), "danger");
      }
    }, (err) => {
      setDriverLocationStatus("Autorize a localização do celular no navegador. Detalhe: " + err.message, "danger");
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 15000 });
    driverLocationWatchId = navigator.geolocation.watchPosition(async (pos) => {
      try {
        await saveDriverLocationPoint(callId || "", pos, { vehicleId });
      } catch (err) {
        setDriverLocationStatus("Falha ao enviar localização: " + (err && err.message || "permissão negada"), "danger");
      }
    }, (err) => {
      setDriverLocationStatus("GPS em espera: autorize localização ou aguarde sinal melhor. Detalhe: " + err.message, "danger");
    }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 15000 });
  }

  async function setStatus(id, status) {
    const call = state.calls[id];
    if (!call) return;
    const key = statusKey(status);
    const label = statusLabel(key);
    if (key === "finalizado" && !["completo", "revisado"].includes(call.proofStatus || proofStatusFor(call))) {
      return toast("Antes de finalizar, salve checklist, fotos obrigatórias e assinatura/aceite do cliente em Provas do atendimento.", "danger");
    }
    const updates = {
      status: label,
      statusKey: key,
      closedAt: key === "finalizado" ? new Date().toISOString() : call.closedAt || "",
      closedBy: key === "finalizado" ? state.user.uid : call.closedBy || "",
      closedByEmail: key === "finalizado" ? state.user.email : call.closedByEmail || "",
      locked: key === "finalizado" ? true : call.locked || false,
      phoneLocationActive: key === "finalizado" ? false : call.phoneLocationActive || false,
      updatedAt: new Date().toISOString(),
      timeline: arrayUnion({ at: new Date().toISOString(), by: state.profile.nome || state.user.email, text: "Motorista alterou status para " + label })
    };
    await db.collection("calls").doc(id).update(updates);
    await syncPublicCallFromDriver(call, updates).catch((err) => console.warn("Falha ao atualizar espelho público", err));
    if (key === "finalizado") stopDriverPhoneLocation();
    toast("Chamado atualizado.", "ok");
  }

  async function uploadToCloudinaryAsset(file, options) {
    const cloud = activeCloudinaryConfig();
    if (!file) return null;
    if (!cloud.cloudName || !cloud.uploadPreset) {
      throw new Error("Cloudinary não configurado: salve cloudName e uploadPreset no superadmin antes de enviar fotos.");
    }
    const preparedFile = await imageFileToCanvas(file, 1600, 0.82);
    const endpoint = `https://api.cloudinary.com/v1_1/${cloud.cloudName}/upload`;

    function buildForm(withFolder) {
      const form = new FormData();
      if (options && options.fileName) form.append("file", preparedFile, options.fileName);
      else form.append("file", preparedFile);
      form.append("upload_preset", cloud.uploadPreset);
      if (withFolder) {
        const folder = [cloud.folder || "jm-guinchos", options && options.folder].filter(Boolean).join("/");
        if (folder) form.append("folder", folder);
      }
      return form;
    }

    async function send(withFolder) {
      const controller = window.AbortController ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 45000) : null;
      let response;
      try {
        response = await fetch(endpoint, { method: "POST", body: buildForm(withFolder), signal: controller && controller.signal });
      } finally {
        if (timer) clearTimeout(timer);
      }
      let data = null;
      try { data = await response.json(); } catch (_) {}
      if (!response.ok) {
        const detail = data && data.error && data.error.message ? data.error.message : "Cloudinary recusou o upload.";
        const err = new Error(detail);
        err.status = response.status;
        throw err;
      }
      return data || {};
    }

    let data;
    try {
      data = await send(true);
    } catch (err) {
      const msg = String(err && err.message || "").toLowerCase();
      if (err && err.name === "AbortError") throw new Error("Tempo esgotado ao enviar para o Cloudinary. Teste com uma foto menor ou confira a internet do celular.");
      if (/folder|public_id|parameter|not allowed|disallowed|unsigned|preset/i.test(msg)) {
        data = await send(false);
      } else {
        throw err;
      }
    }

    if (!data.secure_url && !data.url) throw new Error("Cloudinary respondeu, mas não devolveu URL do arquivo.");
    return {
      cloudinaryUrl: data.secure_url || data.url || "",
      publicId: data.public_id || "",
      resourceType: data.resource_type || "image",
      bytes: data.bytes || 0,
      format: data.format || "",
      uploadedAt: new Date().toISOString()
    };
  }

  async function uploadToCloudinary(file) {
    const asset = await uploadToCloudinaryAsset(file);
    return asset && asset.cloudinaryUrl || "";
  }

  $("driverExpenseForm").onsubmit = async (e) => {
    e.preventDefault();
    const photo = $("driverExpensePhoto").files && $("driverExpensePhoto").files[0];
    let photoUrl = "";
    try { photoUrl = await uploadToCloudinary(photo); } catch (err) { toast("Foto não enviada: " + err.message, "danger"); }
    const callId = $("driverExpenseCall").value;
    const call = callId && state.calls[callId] || null;
    const vehicleId = call && call.vehicleId || $("driverExpenseVehicle").value;
    const expenseType = $("driverExpenseType").value;
    const expenseNotes = $("driverExpenseNotes").value.trim();
    if (isVehicleCostType(expenseType, expenseNotes) && !vehicleId) return toast("Despesa de frota precisa estar vinculada a um veículo. Selecione o caminhão/guincho antes de enviar.", "danger");
    if (callId && !vehicleId) return toast("Este chamado ainda não tem veículo. Selecione o veículo antes de enviar a despesa.", "danger");
    await db.collection("expenses").add({
      callId,
      vehicleId,
      type: expenseType,
      amount: parseMoney($("driverExpenseAmount").value),
      notes: expenseNotes,
      photoUrl,
      status: "pendente",
      driverId: state.user.uid,
      driverName: state.profile.nome || state.user.email,
      customerId: call && call.customerId || "",
      billingParty: callDisplayName(call),
      protocol: callProtocolLabel(call, callId),
      insurance: call && call.insurance || "",
      insuranceProtocol: call && call.insuranceProtocol || "",
      customerPlate: call && call.customerPlate || "",
      sourceType: "driver_expense",
      vehicleCost: !!vehicleId,
      vehicleCostKind: vehicleCostKind(expenseType, expenseNotes),
      vehicleCostCategory: expenseType || "Despesa motorista",
      createdAt: new Date().toISOString(),
      createdBy: state.user.uid
    });
    e.target.reset();
    syncDriverExpenseContext();
    toast("Despesa enviada para aprovação já vinculada ao chamado, veículo e pagador.", "ok");
  };

  $("driverReportForm") && ($("driverReportForm").onsubmit = async (e) => {
    e.preventDefault();
    const callId = $("driverReportCall").value;
    const call = state.calls[callId];
    if (!call) return toast("Selecione um chamado ativo para enviar relatório.", "danger");
    const photo = $("driverReportPhoto").files && $("driverReportPhoto").files[0];
    let photoUrl = "";
    try { photoUrl = await uploadToCloudinary(photo); } catch (err) { toast("Foto não enviada: " + err.message, "danger"); }
    await db.collection("calls").doc(callId).update({
      driverReports: arrayUnion({
        at: new Date().toISOString(),
        by: state.profile.nome || state.user.email,
        checklist: $("driverReportChecklist").value,
        notes: $("driverReportNotes").value.trim(),
        photoUrl
      }),
      timeline: arrayUnion({ at: new Date().toISOString(), by: state.profile.nome || state.user.email, text: "Motorista enviou relatório/checklist" }),
      updatedAt: new Date().toISOString()
    });
    e.target.reset();
    toast("Relatório enviado para a central.", "ok");
  });

  $("driverProofForm") && ($("driverProofForm").onsubmit = async (e) => {
    e.preventDefault();
    const submit = e.submitter || document.querySelector("#driverProofForm button[type='submit']");
    const callId = $("driverProofCall") && $("driverProofCall").value;
    const call = callId && state.calls[callId];
    if (!call) return setProofSubmitStatus("Selecione um chamado ativo para salvar as provas.", "danger");

    const acceptedText = $("signatureAcceptedText").value.trim();
    const signatureRefusalReason = $("signatureRefusalReason") ? $("signatureRefusalReason").value.trim() : "";
    const signaturePhase = $("signaturePhase") ? $("signaturePhase").value : "finalizacao";
    const hasNewSignature = !!(signaturePad && signaturePad.dirty);
    if ((hasNewSignature || signatureRefusalReason) && !acceptedText) return setProofSubmitStatus("O aceite textual é obrigatório quando houver assinatura ou justificativa de recusa.", "danger");

    const previousChecklist = call.proofChecklist || {};
    const checklist = {
      notes: $("proofChecklistNotes").value.trim() || previousChecklist.notes || "",
      vehicleInspection: technicalInspectionPayload(),
      damageAssessment: damageAssessmentPayload(),
      updatedAt: new Date().toISOString(),
      updatedBy: state.user.uid
    };
    PROOF_STAGES.forEach((stage) => {
      const cfg = PROOF_STAGE_FIELDS[stage] || {};
      const select = stageSelect(stage);
      const previous = previousChecklist[stage] || {};
      const justification = cfg.justification && $(cfg.justification) ? $(cfg.justification).value.trim() : previous.justificativa || "";
      const selectedStatus = select && select.value || "pendente";
      const touched = !!(select && select.dataset.touched === "true");
      const shouldUpdate = touched || !!justification || selectedStatus !== (previous.status || "pendente");
      checklist[stage] = Object.assign({}, previous, {
        status: shouldUpdate ? selectedStatus : previous.status || "pendente",
        label: cfg.label || previous.label || stage,
        justificativa: shouldUpdate ? justification : previous.justificativa || ""
      });
    });
    const hasStageTouchedNow = PROOF_STAGES.some((stage) => {
      const select = stageSelect(stage);
      return !!(select && select.dataset.touched === "true");
    });
    const hasAnyStageUpdate = PROOF_STAGES.some((stage) => checklist[stage].status !== "pendente");
    const stagesNeedingJustification = PROOF_STAGES.filter((stage) => {
      const select = stageSelect(stage);
      const row = checklist[stage] || {};
      const touched = !!(select && select.dataset.touched === "true");
      const hasDamageDescription = stage === "retirada"
        && String(row.status || "") === "avaria"
        && (selectedDamageParts.size > 0)
        && (($("proofDamageDetails") && $("proofDamageDetails").value.trim()) || Object.values(selectedDamageNotes).some((note) => String(note || "").trim()));
      return touched && !hasDamageDescription && ["avaria", "intercorrencia", "recusa", "justificado"].includes(String(row.status || "")) && !String(row.justificativa || "").trim();
    });
    if (stagesNeedingJustification.length) {
      return setProofSubmitStatus("Preencha a justificativa das etapas: " + stagesNeedingJustification.map((stage) => checklist[stage].label || stage).join(", ") + ".", "danger");
    }

    const requiredPhotos = requiredProofPhotosForChecklist(checklist);
    const existingPhotos = proofPhotos(call);
    const selectedPhotos = REQUIRED_PHOTOS.filter((photo) => {
      const input = $(photo.input);
      return !!(input && input.files && input.files[0]);
    });
    const missingBeforeUpload = requiredPhotos.filter((photo) => !hasPhotoType(call, photo.key) && !selectedPhotos.some((p) => p.key === photo.key));
    if (!hasStageTouchedNow && !selectedPhotos.length && !hasNewSignature && !signatureRefusalReason && !checklist.notes && selectedDamageParts.size === 0) {
      return setProofSubmitStatus("Toque na etapa que esta registrando agora, marque avarias no desenho ou envie pelo menos uma foto/assinatura/justificativa.", "danger");
    }
    if (missingBeforeUpload.length) {
      return setProofSubmitStatus("Faltam fotos obrigatórias para a etapa marcada: " + missingBeforeUpload.map((photo) => photo.label).join(", ") + ". Se não for possível fotografar, marque a etapa como Justificado e escreva o motivo.", "danger");
    }

    const cloud = activeCloudinaryConfig();
    const needsCloudinary = selectedPhotos.length > 0 || hasNewSignature;
    if (needsCloudinary && (!cloud.cloudName || !cloud.uploadPreset)) {
      return setProofSubmitStatus("Cloudinary não configurado para envio de arquivos. Entre no superadmin, salve cloudName e uploadPreset, depois atualize esta tela.", "danger");
    }

    submit.disabled = true;
    submit.dataset.originalText = submit.dataset.originalText || submit.textContent;
    submit.textContent = "Enviando provas...";
    setProofSubmitStatus("Iniciando envio das provas. Não feche esta tela.", "info", false);

    try {
      const gps = await getCurrentPositionSafe();
      const uploadedPhotos = [];
      for (let i = 0; i < selectedPhotos.length; i += 1) {
        const photo = selectedPhotos[i];
        const input = $(photo.input);
        const file = input && input.files && input.files[0];
        if (!file) continue;
        setProofSubmitStatus(`Enviando ${i + 1}/${selectedPhotos.length}: ${photo.label}...`, "info", false);
        const asset = await uploadToCloudinaryAsset(file, { folder: "provas/" + callId });
        if (!asset || !asset.cloudinaryUrl) throw new Error("Upload sem URL retornada para " + photo.label + ".");
        uploadedPhotos.push(Object.assign({}, asset, {
          type: photo.key,
          label: photo.label,
          callId,
          uploadedBy: state.user.uid,
          uploadedByName: state.profile.nome || state.user.email
        }));
      }

      const replacedTypes = new Set(uploadedPhotos.map((photo) => photo.type));
      const proofPhotosMerged = existingPhotos.filter((photo) => !replacedTypes.has(photo.type)).concat(uploadedPhotos);
      let customerSignature = call.customerSignature || null;
      const phaseSignatures = Object.assign({}, call.phaseSignatures || {});
      const sigBlob = await signatureBlob();
      if (sigBlob) {
        setProofSubmitStatus("Enviando assinatura do cliente...", "info", false);
        const sigAsset = await uploadToCloudinaryAsset(sigBlob, { folder: "assinaturas/" + callId, fileName: "assinatura-" + callId + ".png" });
        if (!sigAsset || !sigAsset.cloudinaryUrl) throw new Error("A assinatura foi enviada, mas não retornou URL.");
        const signatureData = Object.assign({}, sigAsset, {
          signatureUrl: sigAsset.cloudinaryUrl || "",
          name: $("signatureCustomerName").value.trim(),
          document: $("signatureCustomerDoc").value.trim(),
          acceptedText,
          signedAt: new Date().toISOString(),
          gps,
          phase: signaturePhase,
          driverId: state.user.uid,
          driverName: state.profile.nome || state.user.email
        });
        phaseSignatures[signaturePhase] = signatureData;
        customerSignature = signaturePhase === "entrega" || signaturePhase === "finalizacao" ? signatureData : (customerSignature || signatureData);
      } else if (customerSignature) {
        customerSignature = Object.assign({}, customerSignature, { acceptedText, reusedAt: new Date().toISOString() });
      } else if (signatureRefusalReason) {
        const signatureData = {
          refused: true,
          signatureUrl: "",
          name: $("signatureCustomerName").value.trim(),
          document: $("signatureCustomerDoc").value.trim(),
          acceptedText,
          refusalReason: signatureRefusalReason,
          signedAt: new Date().toISOString(),
          gps,
          phase: signaturePhase,
          driverId: state.user.uid,
          driverName: state.profile.nome || state.user.email
        };
        phaseSignatures[signaturePhase] = signatureData;
        customerSignature = signaturePhase === "entrega" || signaturePhase === "finalizacao" ? signatureData : (customerSignature || signatureData);
      }

      const nextCall = Object.assign({}, call, { proofChecklist: checklist, proofPhotos: proofPhotosMerged, customerSignature, phaseSignatures });
      const missingAfterUpload = requiredPhotos.filter((photo) => !proofPhotosMerged.some((saved) => saved && saved.type === photo.key && saved.cloudinaryUrl));
      const nextProofStatus = (missingAfterUpload.length === 0 && hasCompleteChecklist(nextCall) && hasOperationalPhaseAcceptances(nextCall)) ? "completo" : "parcial";
      setProofSubmitStatus("Salvando provas no chamado...", "info", false);
      const callUpdates = {
        proofChecklist: checklist,
        damageAssessment: checklist.damageAssessment,
        proofPhotos: proofPhotosMerged,
        customerSignature,
        phaseSignatures,
        proofStatus: nextProofStatus,
        proofMissingPhotos: missingAfterUpload.map((photo) => photo.label),
        proofUpdatedAt: new Date().toISOString(),
        proofUpdatedBy: state.user.uid,
        billingStatus: nextProofStatus === "completo" && call.billingStatus === "aguardando_provas" ? "a_faturar" : call.billingStatus || "aberto",
        timeline: arrayUnion({ at: new Date().toISOString(), by: state.profile.nome || state.user.email, text: "Motorista salvou evidências da etapa: " + (checklist[signaturePhase] && checklist[signaturePhase].label || signaturePhase) }),
        updatedAt: new Date().toISOString()
      };
      await db.collection("calls").doc(callId).set(callUpdates, { merge: true });
      await syncPublicCallFromDriver(call, callUpdates).catch((err) => console.warn("Falha ao atualizar espelho público", err));

      let auditWarning = "";
      try {
        await db.collection("callProofs").add({
          callId,
          driverId: state.user.uid,
          driverName: state.profile.nome || state.user.email,
          vehicleId: call.vehicleId || "",
          customerId: call.customerId || "",
          protocol: callProtocolLabel(call, callId),
          insurance: call.insurance || "",
          checklist,
          damageAssessment: checklist.damageAssessment,
          photos: uploadedPhotos,
          customerSignature,
          phaseSignatures,
          proofStatus: nextProofStatus,
          gps,
          createdAt: new Date().toISOString()
        });
      } catch (proofLogErr) {
        auditWarning = " As provas foram salvas no chamado, mas o histórico callProofs não gravou: " + (proofLogErr && (proofLogErr.code || proofLogErr.message) || "sem detalhe") + ".";
        try {
          await db.collection("calls").doc(callId).set({ proofLogWarning: auditWarning, proofLogWarningAt: new Date().toISOString() }, { merge: true });
        } catch (_) {}
      }

      REQUIRED_PHOTOS.forEach((photo) => {
        const input = $(photo.input);
        if (input) input.value = "";
      });
      fieldValue("signatureRefusalReason", "");
      if (signaturePad) {
        signaturePad.ctx.clearRect(0, 0, signaturePad.canvas.width, signaturePad.canvas.height);
        signaturePad.dirty = false;
        signaturePad.drawing = false;
      }
      loadProofFormForCall(callId, nextCall);
      const savedLabels = proofPhotoLabelList(uploadedPhotos) || "nenhuma foto nova, dados atualizados";
      const missingText = missingAfterUpload.length ? " Faltam para ficar completo: " + missingAfterUpload.map((photo) => photo.label).join(", ") + "." : "";
      const okMsg = nextProofStatus === "completo"
        ? "Provas completas e salvas. O chamado já pode ser finalizado." + auditWarning
        : "Etapa salva: " + savedLabels + "." + missingText + " As demais etapas podem continuar pendentes até o atendimento chegar nelas." + auditWarning;
      setProofSubmitStatus(okMsg, auditWarning ? "warn" : "success");
    } catch (err) {
      const detail = err && (err.code || err.message) || "falha operacional";
      setProofSubmitStatus("Não consegui salvar as provas: " + detail, "danger");
    } finally {
      submit.disabled = false;
      submit.textContent = submit.dataset.originalText || "Salvar provas e assinatura";
    }
  });

  window.JM = window.JM || {};
  window.JM.motorista = { setStatus, acceptCall, openRouteForCall, openExternalRouteForCall, startRouteForCall, startLocationForCall: startDriverPhoneLocation, stopDriverPhoneLocation, state };
  setupProofStageButtons();
  setupSignaturePad();
  setupDamageDiagram();
  setupAccessoryChecklist();
  applyMobileGpsVisibility();
  if (typeof setupCollapsiblePanels === "function") {
    setupCollapsiblePanels(document, { collapseOnMobile: true, openFirst: 1 });
    setTimeout(() => setupCollapsiblePanels(document, { collapseOnMobile: true, openFirst: 1 }), 250);
    window.addEventListener("load", () => setupCollapsiblePanels(document, { collapseOnMobile: true, openFirst: 1 }), { once: true });
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js?v=" + DRIVER_FLOW_VERSION).catch(() => {});
}());
