const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const LIBRE_EMAIL = process.env.LIBRE_EMAIL;
const LIBRE_PASSWORD = process.env.LIBRE_PASSWORD;

const API_BASE = 'https://api-eu.libreview.io';
const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Version': '4.16.0',
  'Product': 'llu.android',
  'User-Agent': 'FreeStyle LibreLink Up/4.16.0 (Android; 14)'
};

let authToken = null;
let patientId = null;
let lastLoginTime = 0;

async function login() {
  const res = await axios.post(`${API_BASE}/llu/auth/login`, {
    email: LIBRE_EMAIL,
    password: LIBRE_PASSWORD
  }, { headers: HEADERS });
  authToken = res.data.data.authTicket.token;
  lastLoginTime = Date.now();
  return authToken;
}

async function getConnections() {
  if (!authToken) await login();
  const res = await axios.get(`${API_BASE}/llu/connections`, {
    headers: { ...HEADERS, 'Authorization': `Bearer ${authToken}` }
  });
  patientId = res.data.data[0].patientId;
  return patientId;
}

async function getReadings() {
  if (!authToken || Date.now() - lastLoginTime > 50 * 60 * 1000) {
    authToken = null;
    await login();
  }
  if (!patientId) await getConnections();
  const res = await axios.get(`${API_BASE}/llu/connections/${patientId}/graph`, {
    headers: { ...HEADERS, 'Authorization': `Bearer ${authToken}` }
  });
  return res.data;
}

app.use(express.json());
app.use(express.static('public'));

app.get('/api/glucose', async (req, res) => {
  try {
    const data = await getReadings();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
