(function () {
  "use strict";

  const cfg = window.JM_CONFIG || {};
  if (!window.firebase) throw new Error("Firebase SDK não carregou.");
  if (!firebase.apps.length) firebase.initializeApp(cfg.firebaseConfig);
  let secondaryApp;
  try {
    secondaryApp = firebase.app("SecondaryAuth");
  } catch (e) {
    secondaryApp = firebase.initializeApp(cfg.firebaseConfig, "SecondaryAuth");
  }

  const auth = firebase.auth();
  const secondaryAuth = secondaryApp.auth();
  const db = firebase.firestore();
  db.enablePersistence({ synchronizeTabs: true }).catch(() => {});

  const realtimeApps = {};
  function safeAppName(url) {
    return "JMRealtime_" + String(url || "default").replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80);
  }
  function getRealtimeDb(databaseURL) {
    if (!firebase.database) return null;
    const url = String(databaseURL || (cfg.firebaseConfig && cfg.firebaseConfig.databaseURL) || "").trim();
    if (!url) return null;
    try {
      return firebase.database(url);
    } catch (_) {}
    try {
      return firebase.app().database(url);
    } catch (_) {}
    const name = safeAppName(url);
    if (!realtimeApps[name]) {
      let app;
      try {
        app = firebase.app(name);
      } catch (_) {
        app = firebase.initializeApp(Object.assign({}, cfg.firebaseConfig || {}, { databaseURL: url }), name);
      }
      realtimeApps[name] = app.database();
    }
    return realtimeApps[name];
  }
  function rtdbKey(value) {
    return String(value || "sem_id").replace(/[.#$\[\]\/]/g, "_");
  }

  window.JM = window.JM || {};
  window.JM.firebase = {
    auth,
    secondaryAuth,
    db,
    ts: () => firebase.firestore.FieldValue.serverTimestamp(),
    arrayUnion: (value) => firebase.firestore.FieldValue.arrayUnion(value),
    getRealtimeDb,
    rtdbKey,
    emailIsAdmin(email) {
      return (cfg.auth && cfg.auth.adminEmails || []).map((e) => String(e).toLowerCase()).includes(String(email || "").toLowerCase());
    },
    emailIsSuperAdmin(email) {
      return (cfg.auth && cfg.auth.superadminEmails || cfg.auth && cfg.auth.adminEmails || []).map((e) => String(e).toLowerCase()).includes(String(email || "").toLowerCase());
    }
  };
}());
