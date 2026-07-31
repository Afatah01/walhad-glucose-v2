const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    libreEmail: process.env.LIBRE_EMAIL,
    librePassword: process.env.LIBRE_PASSWORD,
    telegramToken: process.env.TELEGRAM_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    alertNumber: process.env.ALERT_NUMBER || '',
    dataFile: path.join(__dirname, 'data.json'),
    lowThreshold: 70,
    highThreshold: 250,
    fetchInterval: 90000,
    saveInterval: 5 * 60 * 1000
};

if (!CONFIG.libreEmail || !CONFIG.librePassword) {
    console.error('ERROR: LIBRE_EMAIL and LIBRE_PASSWORD required');
    process.exit(1);
}

// ============================================
// DATA STORES
// ============================================
let latestReading = null;
let readingHistory = [];
let mealLog = [];
let lastLocation = null;
let smsQueue = [];
let lastAlertedValue = null;
let lastAlertTime = 0;
let serverStartTime = new Date().toISOString();

// ============================================
// LIBRE API (DIRECT - FIXES 403 ERROR)
// ============================================
const API_BASES = [
    { base: 'https://api.libreview.io', name: 'Global' },
    { base: 'https://api-eu.libreview.io', name: 'EU' },
    { base: 'https://api-us.libreview.io', name: 'US' }
];

const HEADERS = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Version': '4.17.0',
    'Product': 'llu.android',
    'User-Agent': 'FreeStyle LibreLink Up/4.17.0 (Android; 14)',
    'Accept-Language': 'en-US,en;q=0.9'
};

let workingBase = null;
let authToken = null;
let patientId = null;
let lastLoginTime = 0;

async function tryLogin(baseUrl) {
    try {
        console.log('[Libre] Trying', baseUrl);
        const res = await axios.post(baseUrl + '/llu/auth/login', {
            email: CONFIG.libreEmail,
            password: CONFIG.librePassword
        }, { headers: HEADERS, timeout: 15000 });

        if (res.data.status === 4) {
            return { success: false, error: 'Terms of Service not accepted. Open LibreLinkUp app and accept latest terms.' };
        }
        if (res.data.status === 2) {
            return { success: false, error: 'Invalid credentials. Check email/password.' };
        }
        if (res.data.data && res.data.data.authTicket && res.data.data.authTicket.token) {
            workingBase = baseUrl;
            authToken = res.data.data.authTicket.token;
            lastLoginTime = Date.now();
            console.log('[Libre] Login success on', baseUrl);
            return { success: true };
        }
        return { success: false, error: 'Unexpected response: ' + JSON.stringify(res.data) };
    } catch (err) {
        console.error('[Libre] Failed on', baseUrl, ':', err.response?.status, err.response?.data?.message || err.message);
        return { success: false, error: err.message, status: err.response?.status };
    }
}

async function login() {
    if (workingBase) {
        const r = await tryLogin(workingBase);
        if (r.success) return;
        workingBase = null;
    }
    for (const cfg of API_BASES) {
        const r = await tryLogin(cfg.base);
        if (r.success) return;
    }
    throw new Error('Libre login failed on all servers');
}

async function getConnections() {
    if (!authToken) await login();
    const res = await axios.get(workingBase + '/llu/connections', {
        headers: { ...HEADERS, Authorization: 'Bearer ' + authToken },
        timeout: 15000
    });
    if (!res.data.data || res.data.data.length === 0) {
        throw new Error('No connections. Father must share in LibreLinkUp app.');
    }
    patientId = res.data.data[0].patientId;
    return res.data.data[0];
}

async function getReadings() {
    if (!authToken || Date.now() - lastLoginTime > 50 * 60 * 1000) {
        authToken = null;
        await login();
    }
    if (!patientId) await getConnections();
    const res = await axios.get(workingBase + '/llu/connections/' + patientId + '/graph', {
        headers: { ...HEADERS, Authorization: 'Bearer ' + authToken },
        timeout: 15000
    });
    return res.data;
}

// ============================================
// PERSISTENCE
// ============================================
function loadData() {
    try {
        if (fs.existsSync(CONFIG.dataFile)) {
            const raw = fs.readFileSync(CONFIG.dataFile, 'utf8');
            const data = JSON.parse(raw);
            readingHistory = data.readingHistory || [];
            mealLog = data.mealLog || [];
            lastLocation = data.lastLocation || null;
            const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
            readingHistory = readingHistory.filter(r => new Date(r.timestamp).getTime() > weekAgo);
            console.log('[Data] Loaded', readingHistory.length, 'readings');
        }
    } catch (e) {
        console.error('[Data] Load error:', e.message);
    }
}

function saveData() {
    try {
        const data = { readingHistory, mealLog, lastLocation, savedAt: new Date().toISOString() };
        fs.writeFileSync(CONFIG.dataFile, JSON.stringify(data, null, 2));
        console.log('[Data] Saved');
    } catch (e) {
        console.error('[Data] Save error:', e.message);
    }
}

setInterval(saveData, CONFIG.saveInterval);
process.on('SIGINT', () => { saveData(); process.exit(0); });
process.on('SIGTERM', () => { saveData(); process.exit(0); });

// ============================================
// ALERT SYSTEM
// ============================================
function queueSMS(text) {
    smsQueue.push({ text, time: new Date().toISOString(), id: Date.now() });
    if (smsQueue.length > 50) smsQueue.shift();
    console.log('[SMS] Queued:', text.substring(0, 60) + '...');
}

async function sendTelegram(message) {
    if (!CONFIG.telegramToken || !CONFIG.telegramChatId) return;
    try {
        await axios.post('https://api.telegram.org/bot' + CONFIG.telegramToken + '/sendMessage', {
            chat_id: CONFIG.telegramChatId,
            text: message,
            parse_mode: 'HTML'
        }, { timeout: 10000 });
        console.log('[Telegram] Sent');
    } catch (e) {
        console.error('[Telegram] Failed:', e.message);
    }
}

function sendAlert(type, value) {
    const time = new Date().toLocaleTimeString();
    let smsMsg = '';
    let telegramMsg = '';

    if (type === 'low') {
        smsMsg = 'LOW GLUCOSE ALERT!\nFather: ' + value + ' mg/dL\nTime: ' + time + '\nGive sugar immediately!';
        telegramMsg = '<b>LOW GLUCOSE</b>\n<b>Father: ' + value + ' mg/dL</b>\nTime: ' + time + '\nGive sugar NOW!';
    } else {
        smsMsg = 'HIGH GLUCOSE ALERT!\nFather: ' + value + ' mg/dL\nTime: ' + time + '\nCheck insulin & hydration!';
        telegramMsg = '<b>HIGH GLUCOSE</b>\n<b>Father: ' + value + ' mg/dL</b>\nTime: ' + time + '\nCheck insulin!';
    }

    if (lastLocation && lastLocation.mapsUrl) {
        smsMsg += '\n\nLocation:\n' + lastLocation.mapsUrl;
        telegramMsg += '\n\n<a href="' + lastLocation.mapsUrl + '">View Map</a>';
    }

    queueSMS(smsMsg);
    sendTelegram(telegramMsg);
}

// ============================================
// GLUCOSE FETCHING
// ============================================
async function fetchGlucose() {
    try {
        const data = await getReadings();
        const connection = data.data.connection;
        const graphData = data.data.graphData || [];
        const current = graphData[graphData.length - 1];

        if (!current) {
            console.log('[Glucose] No current reading');
            return;
        }

        const value = current.Value || current.value || 0;
        const trend = current.TrendArrow || current.trendArrow || 'None';
        const timestamp = current.Timestamp || current.timestamp || current.FactoryTimestamp || new Date().toISOString();

        latestReading = {
            value: value,
            timestamp: timestamp,
            trend: trend,
            unit: 'mg/dL'
        };

        readingHistory.push(latestReading);
        const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        readingHistory = readingHistory.filter(r => new Date(r.timestamp).getTime() > weekAgo);

        console.log('[Glucose]', new Date().toLocaleTimeString(), '|', value, 'mg/dL |', trend);

        // Alerts
        const now = Date.now();
        const timeSinceLastAlert = now - lastAlertTime;
        const valueChanged = lastAlertedValue !== value;

        if (timeSinceLastAlert > 5 * 60 * 1000 && valueChanged) {
            if (value < CONFIG.lowThreshold) {
                sendAlert('low', value);
                lastAlertedValue = value;
                lastAlertTime = now;
            } else if (value > CONFIG.highThreshold) {
                sendAlert('high', value);
                lastAlertedValue = value;
                lastAlertTime = now;
            }
        }

        if (value >= CONFIG.lowThreshold && value <= CONFIG.highThreshold) {
            lastAlertedValue = null;
        }

    } catch (err) {
        console.error('[Glucose] Fetch error:', err.message);
    }
}

// ============================================
// EXPRESS ROUTES
// ============================================
app.use(express.json());
app.use(express.static('public'));

app.get('/api/glucose', async (req, res) => {
    try {
        const data = await getReadings();
        const connection = data.data.connection;
        const graphData = data.data.graphData || [];
        const current = graphData[graphData.length - 1];

        if (current) {
            const value = current.Value || current.value || 0;
            const now = Date.now();
            const timeSinceLastAlert = now - lastAlertTime;
            const valueChanged = lastAlertedValue !== value;

            if (timeSinceLastAlert > 5 * 60 * 1000 && valueChanged) {
                if (value < CONFIG.lowThreshold) {
                    sendAlert('low', value);
                    lastAlertedValue = value;
                    lastAlertTime = now;
                } else if (value > CONFIG.highThreshold) {
                    sendAlert('high', value);
                    lastAlertedValue = value;
                    lastAlertTime = now;
                }
            }
            if (value >= CONFIG.lowThreshold && value <= CONFIG.highThreshold) {
                lastAlertedValue = null;
            }
        }

        const now = Date.now();
        const dayAgo = now - 24 * 60 * 60 * 1000;
        const dayHistory = readingHistory.filter(r => new Date(r.timestamp).getTime() > dayAgo);
        const values = dayHistory.map(r => r.value);

        const inRange = values.filter(v => v >= 70 && v <= 180).length;
        const lowEvents = values.filter(v => v < 70).length;
        const highEvents = values.filter(v => v > 180).length;
        const avg = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
        const tir = values.length ? Math.round((inRange / values.length) * 100) : 0;

        res.json({
            current: latestReading,
            history: readingHistory.slice(-48),
            location: lastLocation,
            stats: { avg, tir, lowEvents, highEvents, totalReadings: values.length },
            serverUptime: serverStartTime
        });
    } catch (error) {
        console.error('[API] Glucose error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/location', (req, res) => {
    const { lat, lng, acc, device } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    lastLocation = {
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        acc: acc || 0,
        device: device || 'unknown',
        time: new Date().toISOString(),
        mapsUrl: 'https://www.google.com/maps?q=' + lat + ',' + lng
    };
    console.log('[Location]', lat, lng);
    res.json({ success: true });
});

app.get('/api/location', (req, res) => {
    res.json(lastLocation || { error: 'No location yet' });
});

app.get('/api/sms-queue', (req, res) => {
    const messages = [...smsQueue];
    smsQueue = [];
    res.json(messages);
});

app.post('/api/alert-test', (req, res) => {
    const testMsg = 'TEST ALERT\nWalhad Family Dashboard\nSMS Gateway working!\nTime: ' + new Date().toLocaleTimeString();
    queueSMS(testMsg);
    sendTelegram('<b>Test Alert</b>\nWalhad Family Dashboard\nServer running!');
    res.json({ success: true, message: 'Test alert queued' });
});

app.get('/api/export', (req, res) => {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const dayHistory = readingHistory.filter(r => new Date(r.timestamp).getTime() > dayAgo);
    let csv = 'Date,Time,Glucose (mg/dL),Trend\n';
    dayHistory.forEach(r => {
        const d = new Date(r.timestamp);
        csv += d.toLocaleDateString() + ',' + d.toLocaleTimeString() + ',' + r.value + ',' + r.trend + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="walhad-glucose-data.csv"');
    res.send(csv);
});

app.post('/api/log', (req, res) => {
    const { type, note, carbs, insulin } = req.body;
    mealLog.push({ type: type || 'note', note: note || '', carbs: carbs || '', insulin: insulin || '', time: new Date().toISOString() });
    if (mealLog.length > 100) mealLog.shift();
    saveData();
    res.json({ success: true });
});

app.get('/api/logs', (req, res) => res.json(mealLog.slice(-20)));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: serverStartTime, glucose: latestReading ? 'connected' : 'waiting' });
});

// ============================================
// HTML DASHBOARD
// ============================================
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0b1120">
<title>Walhad Family Glucose Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{--bg:#0b1120;--card:#151e32;--accent:#3b82f6;--accent2:#8b5cf6;--text:#e2e8f0;--muted:#64748b;--danger:#ef4444;--warning:#f59e0b;--success:#22c55e}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:16px;padding-top:max(16px,env(safe-area-inset-top));padding-bottom:max(16px,env(safe-area-inset-bottom))}
.container{max-width:480px;margin:0 auto}
.header{text-align:center;margin-bottom:20px}
.header h1{font-size:20px;color:var(--accent)}
.header p{font-size:12px;color:var(--muted);margin-top:4px}
.glucose-card{background:linear-gradient(135deg,#1e3a5f 0%,#0f172a 50%,#1e1b4b 100%);border:1px solid rgba(59,130,246,0.25);border-radius:24px;padding:28px 20px;text-align:center;margin-bottom:16px;box-shadow:0 8px 32px rgba(0,0,0,0.5);position:relative;overflow:hidden}
.glucose-card::before{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:radial-gradient(circle,rgba(59,130,246,0.08) 0%,transparent 60%)}
.g-label{font-size:10px;text-transform:uppercase;letter-spacing:2px;color:var(--muted);position:relative}
.g-value{font-size:88px;font-weight:900;line-height:1;margin:8px 0;position:relative;transition:color .3s}
.g-unit{font-size:16px;color:var(--muted);position:relative}
.g-trend{font-size:44px;margin:6px 0;position:relative}
.g-time{font-size:11px;color:var(--muted);margin-top:6px;position:relative}
.g-status{display:inline-block;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;margin-top:10px;position:relative}
.s-normal{background:rgba(34,197,94,0.15);color:var(--success)}
.s-low{background:rgba(239,68,68,0.15);color:var(--danger)}
.s-high{background:rgba(245,158,11,0.15);color:var(--warning)}
.s-vhigh{background:rgba(239,68,68,0.15);color:var(--danger)}
.c-normal{color:var(--success)}.c-low{color:var(--danger)}.c-high{color:var(--warning)}.c-vhigh{color:var(--danger)}
.stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px}
.stat-card{background:var(--card);border-radius:16px;padding:16px 12px;text-align:center;border:1px solid rgba(255,255,255,0.04)}
.stat-num{font-size:26px;font-weight:800}
.stat-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.stat-sub{font-size:11px;color:var(--muted);margin-top:2px}
.tir-card{background:var(--card);border-radius:16px;padding:16px;margin-bottom:16px;border:1px solid rgba(255,255,255,0.04)}
.tir-title{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
.tir-bar{height:28px;border-radius:14px;overflow:hidden;display:flex}
.tir-segment{height:100%;transition:width .5s ease}
.tir-low{background:var(--danger)}.tir-normal{background:var(--success)}.tir-high{background:var(--warning)}
.tir-legend{display:flex;justify-content:space-around;margin-top:10px}
.tir-item{text-align:center}.tir-val{font-size:14px;font-weight:700}.tir-lab{font-size:10px;color:var(--muted)}
.loc-card{background:var(--card);border-radius:16px;padding:16px;margin-bottom:16px;border:1px solid rgba(255,255,255,0.04)}
.loc-header{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.loc-icon{font-size:18px}.loc-title{font-size:13px;font-weight:600}
.loc-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04)}
.loc-row:last-child{border-bottom:none}.loc-key{font-size:12px;color:var(--muted)}
.loc-val{font-size:12px;font-weight:600;font-family:monospace}
.loc-btn{display:block;width:100%;margin-top:12px;padding:10px;background:linear-gradient(90deg,var(--accent),var(--accent2));color:white;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
.loc-waiting{color:var(--muted);font-size:12px;text-align:center;padding:10px}
.chart-card{background:var(--card);border-radius:16px;padding:16px;margin-bottom:16px;border:1px solid rgba(255,255,255,0.04)}
.chart-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.chart-title{font-size:13px;font-weight:600}
.time-btns{display:flex;gap:6px}
.tbtn{background:rgba(59,130,246,0.1);border:none;color:var(--accent);padding:4px 10px;border-radius:8px;font-size:11px;cursor:pointer}
.tbtn.active{background:var(--accent);color:white}
canvas{width:100%;height:180px}
.log-card{background:var(--card);border-radius:16px;padding:16px;margin-bottom:16px;border:1px solid rgba(255,255,255,0.04)}
.log-title{font-size:13px;font-weight:600;margin-bottom:12px}
.log-inputs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.log-inputs input,.log-inputs select{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px;color:var(--text);font-size:13px}
.log-inputs input::placeholder{color:var(--muted)}
.log-add{width:100%;padding:10px;background:var(--success);color:#0b1120;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer}
.log-list{margin-top:12px;max-height:150px;overflow-y:auto}
.log-item{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px}
.log-item:last-child{border-bottom:none}.log-type{font-weight:600}.log-time{color:var(--muted);font-size:10px}
.action-bar{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
.act-btn{padding:12px;border-radius:12px;font-size:13px;font-weight:600;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px}
.act-export{background:var(--accent);color:white}.act-test{background:var(--warning);color:#0b1120}
.footer{text-align:center;color:var(--muted);font-size:11px;padding:10px}
.live-indicator{display:inline-flex;align-items:center;gap:6px}
.live-dot{width:7px;height:7px;background:var(--success);border-radius:50%;animation:blink 1.5s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.alert-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:1000;align-items:center;justify-content:center;flex-direction:column;padding:20px}
.alert-overlay.show{display:flex}
.alert-box{background:var(--card);border-radius:24px;padding:32px;text-align:center;max-width:320px;width:100%;border:2px solid var(--danger)}
.alert-icon{font-size:60px;margin-bottom:12px}
.alert-title{font-size:22px;font-weight:800;color:var(--danger);margin-bottom:8px}
.alert-msg{font-size:14px;color:var(--muted);margin-bottom:20px}
.alert-val{font-size:48px;font-weight:900;margin:10px 0}
.alert-dismiss{padding:12px 32px;background:var(--danger);color:white;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer}
.status-bar{background:var(--card);border-radius:12px;padding:10px 14px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;border:1px solid rgba(255,255,255,0.04)}
.status-item{font-size:11px;color:var(--muted)}
.status-online{color:var(--success);font-weight:700}
</style>
</head>
<body>
<div class="container">
<div class="header"><h1>🩸 Walhad Family Glucose Dashboard</h1><p>Real-time glucose + location + local SMS alerts</p></div>
<div class="status-bar"><div class="status-item">Server: <span class="status-online" id="srvStatus">● Online</span></div><div class="status-item" id="uptime">--</div></div>
<div class="glucose-card"><div class="g-label">Current Glucose</div><div class="g-value" id="gVal">--</div><div class="g-unit">mg/dL</div><div class="g-trend" id="gTrend">➡️</div><div class="g-time" id="gTime">Waiting for data...</div><div class="g-status" id="gStatus">--</div></div>
<div class="stats-grid"><div class="stat-card"><div class="stat-num" style="color:var(--accent)" id="stAvg">--</div><div class="stat-label">Average (24h)</div><div class="stat-sub">mg/dL</div></div><div class="stat-card"><div class="stat-num" style="color:var(--success)" id="stTIR">--</div><div class="stat-label">Time in Range</div><div class="stat-sub">70-180 mg/dL</div></div><div class="stat-card"><div class="stat-num" style="color:var(--danger)" id="stLow">--</div><div class="stat-label">Low Events</div><div class="stat-sub">&lt; 70 mg/dL</div></div><div class="stat-card"><div class="stat-num" style="color:var(--warning)" id="stHigh">--</div><div class="stat-label">High Events</div><div class="stat-sub">&gt; 180 mg/dL</div></div></div>
<div class="tir-card"><div class="tir-title">📊 Time in Range (24 Hours)</div><div class="tir-bar" id="tirBar"><div class="tir-segment tir-low" id="tirLowSeg" style="width:0%"></div><div class="tir-segment tir-normal" id="tirNormSeg" style="width:0%"></div><div class="tir-segment tir-high" id="tirHighSeg" style="width:0%"></div></div><div class="tir-legend"><div class="tir-item"><div class="tir-val" style="color:var(--danger)" id="tirLowPct">0%</div><div class="tir-lab">Low</div></div><div class="tir-item"><div class="tir-val" style="color:var(--success)" id="tirNormPct">0%</div><div class="tir-lab">In Range</div></div><div class="tir-item"><div class="tir-val" style="color:var(--warning)" id="tirHighPct">0%</div><div class="tir-lab">High</div></div></div></div>
<div class="loc-card"><div class="loc-header"><span class="loc-icon">📍</span><span class="loc-title">Father's Location</span></div><div id="locBox"><div class="loc-waiting">Waiting for GPS...<br><small>Father opens dashboard on his phone and taps "Send Location"</small></div></div></div>
<div class="chart-card"><div class="chart-header"><span class="chart-title">📈 Glucose Trend</span><div class="time-btns"><button class="tbtn active" onclick="setRange(1)">1h</button><button class="tbtn" onclick="setRange(3)">3h</button><button class="tbtn" onclick="setRange(6)">6h</button><button class="tbtn" onclick="setRange(12)">12h</button><button class="tbtn" onclick="setRange(24)">24h</button></div></div><canvas id="chart"></canvas></div>
<div class="log-card"><div class="log-title">📝 Log Meal / Insulin / Activity</div><div class="log-inputs"><select id="logType"><option value="meal">🍽️ Meal</option><option value="insulin">💉 Insulin</option><option value="activity">🏃 Activity</option><option value="note">📝 Note</option></select><input type="text" id="logNote" placeholder="Details..."><input type="number" id="logCarbs" placeholder="Carbs (g)"><input type="number" id="logInsulin" placeholder="Insulin (units)"></div><button class="log-add" onclick="addLog()">➕ Add Entry</button><div class="log-list" id="logList"></div></div>
<div class="action-bar"><button class="act-btn act-export" onclick="exportCSV()">📥 Export CSV</button><button class="act-btn act-test" onclick="testAlert()">🔔 Test Alert</button></div>
<div class="footer"><div class="live-indicator"><div class="live-dot"></div><span id="syncStatus">Auto-sync every 90s</span></div></div>
</div>
<div class="alert-overlay" id="alertOverlay"><div class="alert-box"><div class="alert-icon" id="alertIcon">🚨</div><div class="alert-title" id="alertTitle">GLUCOSE ALERT</div><div class="alert-val" id="alertVal">--</div><div class="alert-msg" id="alertMsg">Check immediately!</div><button class="alert-dismiss" onclick="dismissAlert()">Dismiss</button></div></div>
<script>
const TRENDS={up:'⬆️',down:'⬇️',upFast:'⬆️⬆️',downFast:'⬇️⬇️',stable:'➡️',unknown:'❓'};
let currentRange=1,fullHistory=[];
function getColor(v){return v<70?'c-low':v>250?'c-vhigh':v>180?'c-high':'c-normal'}
function getStatus(v){if(v<70)return{text:'LOW ⚠️',cls:'s-low'};if(v>250)return{text:'VERY HIGH 🚨',cls:'s-vhigh'};if(v>180)return{text:'HIGH ⚡',cls:'s-high'};return{text:'NORMAL ✅',cls:'s-normal'}}
function setRange(h){currentRange=h;document.querySelectorAll('.tbtn').forEach(function(b){b.classList.remove('active')});event.target.classList.add('active');drawChart()}
function drawChart(){var c=document.getElementById('chart'),g=c.getContext('2d');c.width=c.offsetWidth*2;c.height=c.offsetHeight*2;g.scale(2,2);var w=c.offsetWidth,p=25,h=c.offsetHeight;g.clearRect(0,0,w,h);var cutoff=new Date(Date.now()-currentRange*60*60*1000);var hist=fullHistory.filter(function(r){return new Date(r.timestamp)>cutoff});if(hist.length<2){g.fillStyle='#64748b';g.textAlign='center';g.font='14px sans-serif';g.fillText('Collecting data...',w/2,h/2);return}var vals=hist.map(function(r){return r.value}),mn=Math.min.apply(null,vals.concat([70]))-10,mx=Math.max.apply(null,vals.concat([180]))+10,rg=mx-mn||1;var y180=h-p-((180-mn)/rg)*(h-2*p),y70=h-p-((70-mn)/rg)*(h-2*p);g.fillStyle='rgba(34,197,94,0.06)';g.fillRect(p,y180,w-2*p,y70-y180);g.strokeStyle='rgba(148,163,184,0.08)';g.lineWidth=1;for(var i=0;i<=4;i++){var y=p+(i/4)*(h-2*p);g.beginPath();g.moveTo(p,y);g.lineTo(w-p,y);g.stroke()}g.beginPath();g.strokeStyle='#60a5fa';g.lineWidth=2.5;g.lineCap='round';g.lineJoin='round';hist.forEach(function(r,i){var x=p+(i/(hist.length-1))*(w-2*p),y=h-p-((r.value-mn)/rg)*(h-2*p);if(i==0)g.moveTo(x,y);else g.lineTo(x,y)});g.stroke();g.lineTo(p+(w-2*p),h-p);g.lineTo(p,h-p);g.closePath();var gr=g.createLinearGradient(0,p,0,h-p);gr.addColorStop(0,'rgba(96,165,250,0.18)');gr.addColorStop(1,'rgba(96,165,250,0)');g.fillStyle=gr;g.fill();hist.forEach(function(r,i){var x=p+(i/(hist.length-1))*(w-2*p),y=h-p-((r.value-mn)/rg)*(h-2*p);g.beginPath();g.arc(x,y,3,0,Math.PI*2);g.fillStyle=r.value<70||r.value>180?'#ef4444':'#22c55e';g.fill()})}
function playAlert(){try{var ctx=new(window.AudioContext||window.webkitAudioContext)();var o=ctx.createOscillator(),ga=ctx.createGain();o.connect(ga);ga.connect(ctx.destination);o.type='square';o.frequency.value=800;ga.gain.value=0.3;o.start();setTimeout(function(){o.frequency.value=600},200);setTimeout(function(){o.stop()},600)}catch(e){console.log('Audio alert failed',e)}}
function showAlert(val,type){var ov=document.getElementById('alertOverlay');document.getElementById('alertVal').textContent=val+' mg/dL';if(type==='low'){document.getElementById('alertIcon').textContent='🚨';document.getElementById('alertTitle').textContent='LOW GLUCOSE!';document.getElementById('alertMsg').textContent='Glucose is dangerously low. Give sugar immediately!'}else{document.getElementById('alertIcon').textContent='⚠️';document.getElementById('alertTitle').textContent='HIGH GLUCOSE!';document.getElementById('alertMsg').textContent='Glucose is very high. Check insulin and hydration.'}ov.classList.add('show');playAlert();if('vibrate' in navigator)navigator.vibrate([500,200,500,200,500])}
function dismissAlert(){document.getElementById('alertOverlay').classList.remove('show')}
function testAlert(){showAlert(55,'low')}
async function fetchData(){try{var d=await(await fetch('/api/glucose')).json();if(d.current){var v=d.current.value;document.getElementById('gVal').textContent=v;document.getElementById('gVal').className='g-value '+getColor(v);document.getElementById('gTrend').textContent=TRENDS[d.current.trend]||'➡️';document.getElementById('gTime').textContent=new Date(d.current.timestamp).toLocaleString();var s=getStatus(v),se=document.getElementById('gStatus');se.textContent=s.text;se.className='g-status '+s.cls;document.getElementById('syncStatus').textContent='Updated '+new Date().toLocaleTimeString();if(d.stats){document.getElementById('stAvg').textContent=d.stats.avg||'--';document.getElementById('stTIR').textContent=(d.stats.tir||0)+'%';document.getElementById('stLow').textContent=d.stats.lowEvents||0;document.getElementById('stHigh').textContent=d.stats.highEvents||0;var total=d.stats.totalReadings||1;var lp=Math.round((d.stats.lowEvents/total)*100);var np=Math.round(d.stats.tir);var hp=Math.round((d.stats.highEvents/total)*100);document.getElementById('tirLowSeg').style.width=lp+'%';document.getElementById('tirNormSeg').style.width=np+'%';document.getElementById('tirHighSeg').style.width=hp+'%';document.getElementById('tirLowPct').textContent=lp+'%';document.getElementById('tirNormPct').textContent=np+'%';document.getElementById('tirHighPct').textContent=hp+'%'}fullHistory=d.history||[];drawChart();if(d.serverUptime){document.getElementById('uptime').textContent='Started: '+new Date(d.serverUptime).toLocaleDateString()}}if(d.location&&d.location.lat){document.getElementById('locBox').innerHTML='<div class="loc-row"><span class="loc-key">Latitude</span><span class="loc-val">'+d.location.lat+'</span></div><div class="loc-row"><span class="loc-key">Longitude</span><span class="loc-val">'+d.location.lng+'</span></div><div class="loc-row"><span class="loc-key">Accuracy</span><span class="loc-val">±'+(d.location.acc||'?')+'m</span></div><div class="loc-row"><span class="loc-key">Updated</span><span class="loc-val">'+new Date(d.location.time).toLocaleTimeString()+'</span></div><a class="loc-btn" href="'+d.location.mapsUrl+'" target="_blank">🗺️ Open in Google Maps</a>'}}catch(e){document.getElementById('syncStatus').textContent='Sync failed - retrying...';console.error(e)}}
async function addLog(){var type=document.getElementById('logType').value,note=document.getElementById('logNote').value,carbs=document.getElementById('logCarbs').value,insulin=document.getElementById('logInsulin').value;await fetch('/api/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,note,carbs,insulin})});document.getElementById('logNote').value='';document.getElementById('logCarbs').value='';document.getElementById('logInsulin').value='';loadLogs()}
async function loadLogs(){var logs=await(await fetch('/api/logs')).json();document.getElementById('logList').innerHTML=logs.map(function(l){return '<div class="log-item"><div><span class="log-type">'+l.type.toUpperCase()+'</span> '+(l.note||'')+' '+(l.carbs?'('+l.carbs+'g)':'')+' '+(l.insulin?'('+l.insulin+'u)':'')+'</div><div class="log-time">'+new Date(l.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</div></div>'}).reverse().join('')}
function exportCSV(){window.open('/api/export','_blank')}
fetchData();loadLogs();setInterval(fetchData,90000);
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML_PAGE));

// ============================================
// STARTUP
// ============================================
loadData();
fetchGlucose();
setInterval(fetchGlucose, CONFIG.fetchInterval);

app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('============================================');
    console.log('  WALHAD FAMILY GLUCOSE DASHBOARD v2.0');
    console.log('============================================');
    console.log('');
    console.log('Features:');
    console.log('  • Glucose monitoring (LibreLinkUp - Direct API)');
    console.log('  • GPS location tracking');
    console.log('  • LOCAL SMS alerts (via Termux gateway)');
    console.log('  • Telegram backup alerts');
    console.log('  • Data persistence (JSON file)');
    console.log('  • CSV export');
    console.log('  • Meal/insulin logging');
    console.log('');
    console.log('Open: http://localhost:' + PORT);
    console.log('');
});
