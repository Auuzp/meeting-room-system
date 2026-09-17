const fs = require('fs');
const path = require('path');
const { initializeApp, getApps, getApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore: getFirestoreInstance } = require('firebase-admin/firestore');

let firestoreInstance = null;
let appInstance = null;

function initFirestore(config = {}) {
  if (firestoreInstance && !config.forceNew) {
    return firestoreInstance;
  }

  const existingApps = getApps();
  if (existingApps.length > 0 && !config.forceNew) {
    appInstance = getApp();
    firestoreInstance = getFirestoreInstance(appInstance);
    return firestoreInstance;
  }

  // Parse service account key if provided via JSON or file path
  let serviceAccountData = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    try {
      serviceAccountData = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    } catch (_) {
      const resolvedPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
      if (fs.existsSync(resolvedPath)) {
        try {
          serviceAccountData = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
        } catch (_) {}
      }
    }
  }

  const projectId = config.projectId ||
                    process.env.FIREBASE_PROJECT_ID ||
                    (serviceAccountData ? serviceAccountData.project_id : null) ||
                    process.env.GCLOUD_PROJECT;
  const clientEmail = config.clientEmail ||
                      process.env.FIREBASE_CLIENT_EMAIL ||
                      (serviceAccountData ? serviceAccountData.client_email : null);
  let privateKey = config.privateKey ||
                   process.env.FIREBASE_PRIVATE_KEY ||
                   (serviceAccountData ? serviceAccountData.private_key : null);

  if (privateKey) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  let credential;
  if (serviceAccountData) {
    credential = cert(serviceAccountData);
  } else if (projectId && clientEmail && privateKey) {
    credential = cert({
      projectId,
      clientEmail,
      privateKey
    });
  } else if (process.env.FIRESTORE_EMULATOR_HOST) {
    credential = applicationDefault();
  } else {
    try {
      credential = applicationDefault();
    } catch (e) {
      credential = null;
    }
  }

  const appOptions = {};
  if (projectId) {
    appOptions.projectId = projectId;
  }
  if (credential) {
    appOptions.credential = credential;
  }

  appInstance = initializeApp(appOptions, config.appName || (config.forceNew ? `app-${Date.now()}` : undefined));
  firestoreInstance = getFirestoreInstance(appInstance);

  try {
    firestoreInstance.settings({
      ignoreUndefinedProperties: true
    });
  } catch (e) {}

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
