const admin = require('firebase-admin');

let firestoreInstance = null;
let appInstance = null;

function initFirestore(config = {}) {
  if (firestoreInstance && !config.forceNew) {
    return firestoreInstance;
  }

  // If emulator host is set, or if an instance is already active
  if (admin.apps.length > 0 && !config.forceNew) {
    appInstance = admin.app();
    firestoreInstance = admin.firestore();
    return firestoreInstance;
  }

  const projectId = config.projectId || process.env.FIREBASE_PROJECT_ID;
  const clientEmail = config.clientEmail || process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = config.privateKey || process.env.FIREBASE_PRIVATE_KEY;

  if (privateKey) {
    // Handle escaped newlines properly when stored in environment variables
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  let credential;

  // 1. Service account direct env vars
  if (projectId && clientEmail && privateKey) {
    credential = admin.credential.cert({
      projectId,
      clientEmail,
      privateKey
    });
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    // 2. Service account JSON string
    try {
      const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
      credential = admin.credential.cert(parsed);
    } catch (_) {
      // or file path
      credential = admin.credential.cert(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    }
  } else if (process.env.FIRESTORE_EMULATOR_HOST) {
    // 3. Emulator mode (no credentials needed)
    credential = admin.credential.applicationDefault();
  } else {
    // 4. Fallback to Google Application Default Credentials
    try {
      credential = admin.credential.applicationDefault();
    } catch (e) {
      // Credentials not provided
      credential = null;
    }
  }

  const appOptions = {
    projectId: projectId || process.env.GCLOUD_PROJECT || 'meeting-room-system'
  };

  if (credential) {
    appOptions.credential = credential;
  }

  appInstance = admin.initializeApp(appOptions, config.appName || (config.forceNew ? `app-${Date.now()}` : undefined));
  firestoreInstance = admin.firestore(appInstance);

  // Settings
  firestoreInstance.settings({
    ignoreUndefinedProperties: true
  });

  return firestoreInstance;
}

function getFirestore() {
  if (!firestoreInstance) {
    return initFirestore();
  }
  return firestoreInstance;
}

module.exports = {
  initFirestore,
  getFirestore
};
