const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const LIBRE_EMAIL = process.env.LIBRE_EMAIL;
const LIBRE_PASSWORD = process.env.LIBRE_PASSWORD;

const API_BASES = [
  'https://api-eu.libreview.io',
  'https://api-us.libreview.io',
  'https://api.libreview.io'
];

const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Version': '4.17.0',
  'Product': 'llu.android',
  'User-Agent': 'FreeStyle LibreLink Up/4.17.0 (Android; 14)'
};

let authToken = null;
let patientId = null;
let lastLoginTime = 0;
let currentBase = API_BASES[0];

async function login() {
  let lastError = null;
  
  for (const base of API_BASES) {
    try {
      console.log('Trying login on:', base);
      const res = await axios.post(base + '/llu/auth/login', {
        email: LIBRE_EMAIL,
        password: LIBRE_PASSWORD
      }, { headers: HEADERS });
      
      authToken = res.data.data.authTicket.token;
      lastLoginTime = Date.now();
      currentBase = base;
      console.log('Login success on:', base);
      return authToken;
    } catch (err) {
      console.error('Login failed on', base, ':', err.response?.status, JSON.stringify(err.response?.data || err.message));
      lastError = err;
    }
  }
  
  throw lastError;
}

async function getConnections() {
  if (!authToken) await login();
  const res = await axios.get(currentBase + '/llu/connections', {
    headers: { ...HEADERS, Authorization: 'Bearer ' + authToken }
  });
  
  if (!res.data.data || res.data.data.length === 0) {
    throw new Error('No connections found. Make sure your father shared with you in LibreLinkUp app.');
  }
  
  patientId = res.data.data[0].patientId;
  return patientId;
}

async function getReadings() {
  if (!authToken || Date.now() - lastLoginTime > 50 * 60 * 1000) {
    authToken = null;
    await login();
  }
  if (!patientId) await getConnections();
  const res = await axios.get(currentBase + '/llu/connections/' + patientId + '/graph', {
    headers: { ...HEADERS, Authorization: 'Bearer ' + authToken }
  });
  return res.data;
}

app.use(express.json());
app.use(express.static('public'));

app.get('/api/glucose', async (req, res) => {
  try {
    const data = await getReadings();
    res.json({ success: true, data: data });
  } catch (error) {
    const details = error.response?.data || {};
    const status = error.response?.status || 'unknown';
    console.error('Full error:', JSON.stringify(details));
    res.status(500).json({ 
      success: false, 
      error: error.message,
      status: status,
      details: details
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
