/*
 * JM Guinchos - configuração central
 * Frontend estatico: qualquer dado neste arquivo fica visivel no GitHub Pages.
 * Para operação profissional, não publique token de rastreador neste arquivo.
 * Cadastre o token no superadmin.html e troque-o sempre que houver exposição.
 */
window.JM_CONFIG = {
  firebaseConfig: {
    apiKey: "AIzaSyDabz--MxYrnUGo65G3nGKE6h_Tr6h112s",
    authDomain: "frvalencio.firebaseapp.com",
    projectId: "frvalencio",
    storageBucket: "frvalencio.firebasestorage.app",
    messagingSenderId: "1008400858370",
    appId: "1:1008400858370:web:17019357ea499ecd87561b",
    databaseURL: ""
  },
  empresa: {
    nome: "JM Guinchos",
    cidadeBase: "Sao Jose do Rio Preto - SP",
    telefoneOperacional: "(17) 99651-9832",
    moeda: "BRL"
  },
  auth: {
    adminEmails: [
      "jm@jm.com.br",
      "jm@jm.com"
    ],
    superadminEmails: [
      "jm@jm.com.br",
      "jm@jm.com"
    ],
    autoRepairGestorLogin: true
  },
  map: {
    provider: "leaflet_osm",
    paidApi: false,
    country: "br",
    center: { lat: -20.8113, lng: -49.3758 },
    radiusMeters: 90000,
    averageSpeedKmH: 48
  },
  tracker: {
    platformUrl: "https://gps2.rafacarrastreadores.com.br",
    endpoint: "https://gps2.rafacarrastreadores.com.br/api",
    socketUrl: "wss://gps2.rafacarrastreadores.com.br/api/socket",
    token: "",
    tokenHeader: "Authorization",
    tokenPrefix: "Bearer ",
    pollingMs: 30000,
    vehicles: {
      FHA4B30: {
        placa: "FHA4B30",
        apelido: "Guincho",
        tipo: "Guincho plataforma",
        trackerId: "FHA4B30"
      },
      DAJ6J95: {
        placa: "DAJ6J95",
        apelido: "Munck",
        tipo: "Caminhão munck",
        trackerId: "DAJ6J95"
      }
    }
  },
  cloudinary: {
    cloudName: "",
    uploadPreset: "",
    folder: "jm-guinchos"
  },
  mobileGps: {
    enabled: false,
    backend: "firestore",
    databaseURL: "",
    pollingMs: 10000,
    minIntervalMs: 20000,
    minDistanceMeters: 25
  }
};
