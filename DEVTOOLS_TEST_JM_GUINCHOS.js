(function () {
  const ok = (name) => console.log("[OK]", name);
  const fail = (name, msg) => console.error("[FALHA]", name, msg || "falhou");
  const warn = (name, msg) => console.warn("[ATENCAO]", name, msg || "atenção");

  console.log("[JM V20] Teste rápido do navegador");

  window.JM && window.JM.utils ? ok("JM.utils carregado") : fail("JM.utils carregado");
  window.JM && window.JM.firebase ? ok("Firebase carregado") : fail("Firebase carregado");
  window.JM && window.JM.tracker ? ok("Tracker carregado") : fail("Tracker carregado");
  window.JM && window.JM.googleMaps ? ok("Roteirizador OSM/OSRM carregado") : fail("Roteirizador OSM/OSRM carregado");
  window.JM && window.JM.mapa && window.JM.mapa.renderFleetMap ? ok("Mapa Leaflet/OSM carregado") : fail("Mapa Leaflet/OSM carregado");

  const parsed = window.JM.googleMaps && window.JM.googleMaps.parseLocationInput
    ? window.JM.googleMaps.parseLocationInput("-20.851076,-49.398946")
    : null;
  parsed && parsed.coords ? ok("Parser de coordenadas funcionando") : warn("Parser de coordenadas", "função não exposta nesta tela");

  const cfg = window.JM_CONFIG || {};
  cfg.tracker && cfg.tracker.endpoint ? ok("Endpoint tracker configurado") : warn("Endpoint tracker", "faltando endpoint");
  cfg.tracker && cfg.tracker.token ? ok("Token tracker presente") : warn("Token tracker", "normal se o token estiver salvo só no Firestore");

  console.log("[JM V20] Teste esperado: abrir jm.html?v=jm-v20-entrega-final-operacional");
  console.log("[JM V20] Conferir Central Operacional, filtros, SLA, seleção de chamado/veículo, despacho, rota, copiar link e WhatsApp.");
  console.log("[JM V20] Criar chamado de seguradora com protocolo, placa, SLA e motorista; depois testar motorista.html.");
}());
