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

  window.JM = window.JM || {};
  window.JM.firebase = {
    auth,
    secondaryAuth,
    db,
    ts: () => firebase.firestore.FieldValue.serverTimestamp(),
    arrayUnion: (value) => firebase.firestore.FieldValue.arrayUnion(value),
    emailIsAdmin(email) {
      return (cfg.auth && cfg.auth.adminEmails || []).map((e) => String(e).toLowerCase()).includes(String(email || "").toLowerCase());
    },
    emailIsSuperAdmin(email) {
      return (cfg.auth && cfg.auth.superadminEmails || cfg.auth && cfg.auth.adminEmails || []).map((e) => String(e).toLowerCase()).includes(String(email || "").toLowerCase());
    }
  };
}());
