const { onRequest } = require('firebase-functions/v2/https');
const app = require('../server.js');

exports.api = onRequest({
  region: 'asia-southeast1',
  cors: true,
  maxInstances: 10
}, app);
