require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TASKS = require('./tasks.json');
const PLAYLISTS = require('./playlists.json');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    return { notices: [], taskState: {}, incidents: [], referrals: [] };
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---------- access control ----------
// Two shared codes: one for the admin (you), one for lifeguards (more restricted).
function checkCode(req, role) {
  const expected = role === 'admin' ? process.env.ADMIN_ACCESS_CODE : process.env.GUARD_ACCESS_CODE;
  if (!expected) return true; // no code configured yet -> allow (dev mode)
  const provided = req.headers['x-access-code'];
  return provided === expected;
}
function requireCode(role) {
  return (req, res, next) => {
    if (checkCode(req, role)) return next();
    res.status(401).json({ error: 'Invalid or missing access code' });
  };
}

// ---------- task status ----------
const FACILITY_TZ = process.env.FACILITY_TZ || 'America/New_York';
function dayKey(date) {
  return date.toLocaleDateString('en-CA', { timeZone: FACILITY_TZ }); // YYYY-MM-DD in facility-local time
}

function computeStatus(task, state) {
  if (task.recurring === false) {
    return { dueAt: null, overdue: false };
  }
  if (task.cadence === 'daily') {
    // Once-a-day tasks (opening, closing, maintenance): no due time, just
    // "done today" or not, resetting at the start of each facility-local day
    // rather than exactly 24 hours after whenever it was last submitted.
    if (!state || !state.lastCompleted) return { dueAt: null, overdue: true };
    const overdue = dayKey(new Date(state.lastCompleted)) !== dayKey(new Date());
    return { dueAt: null, overdue };
  }
  const intervalMs = (task.intervalMinutes ? task.intervalMinutes : task.intervalHours * 60) * 60 * 1000;
  if (!state || !state.lastCompleted) {
    return { dueAt: null, overdue: true }; // never done -> due now
  }
  const dueAt = new Date(new Date(state.lastCompleted).getTime() + intervalMs);
  return { dueAt: dueAt.toISOString(), overdue: Date.now() > dueAt.getTime() };
}

app.get('/api/tasks', (req, res) => {
  const db = loadDB();
  const out = TASKS.map((t) => {
    const state = db.taskState[t.id] || {};
    const status = computeStatus(t, state);
    return { ...t, lastCompleted: state.lastCompleted || null, ...status };
  });
  res.json(out);
});

app.post('/api/tasks/:id/submit', requireCode('guard'), (req, res) => {
  const task = TASKS.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Unknown task' });
  const db = loadDB();
  db.taskState[task.id] = db.taskState[task.id] || {};
  db.taskState[task.id].lastCompleted = new Date().toISOString();
  db.taskState[task.id].history = db.taskState[task.id].history || [];
  db.taskState[task.id].history.push({
    at: new Date().toISOString(),
    values: req.body.values || {},
  });
  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/tasks/:id/history', requireCode('admin'), (req, res) => {
  const db = loadDB();
  if (req.params.id === 'incident') return res.json(db.incidents.slice().reverse());
  if (req.params.id === 'referral') return res.json(db.referrals.slice().reverse());
  const history = (db.taskState[req.params.id] && db.taskState[req.params.id].history) || [];
  res.json(history.slice().reverse());
});

// ---------- notices ----------
app.get('/api/notices', (req, res) => {
  const db = loadDB();
  res.json(db.notices[db.notices.length - 1] || null);
});
app.post('/api/notices', requireCode('admin'), (req, res) => {
  const db = loadDB();
  db.notices.push({ text: req.body.text || '', at: new Date().toISOString() });
  saveDB(db);
  res.json({ ok: true });
});

// ---------- playlists (button labels only; audio files live on the receiver PC) ----------
app.get('/api/playlists', (req, res) => res.json(PLAYLISTS));

// ---------- email alerts ----------
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
async function sendAlert(subject, body) {
  if (!transporter || !process.env.ALERT_TO) {
    console.log('[email not configured] would send:', subject, '\n', body);
    return;
  }
  try {
    await transporter.sendMail({
      from: process.env.ALERT_FROM || process.env.SMTP_USER,
      to: process.env.ALERT_TO,
      subject,
      text: body,
    });
  } catch (err) {
    console.error('Failed to send alert email:', err);
  }
}

app.post('/api/incidents', requireCode('guard'), (req, res) => {
  const db = loadDB();
  const record = { ...req.body, at: new Date().toISOString() };
  db.incidents.push(record);
  saveDB(db);
  const v = record.values || {};
  const subject = `Incident report - ${v.when || 'time not given'}${v.location ? ', ' + v.location : ''}`;
  const body = [
    `Patrons: ${v.patrons || '-'}`,
    `Staff: ${v.staff || '-'}`,
    `What happened: ${v.whatHappened || '-'}`,
    `Authorities contacted: ${v.authorities || '-'}`,
    `Guards involved: ${v.guardsInvolved || '-'}`,
    `Filed and signed off by: ${v.leadSignoff || '-'}`,
  ].join('\n');
  sendAlert(subject, body);
  res.json({ ok: true });
});

app.post('/api/referrals', requireCode('guard'), (req, res) => {
  const db = loadDB();
  const record = { ...req.body, at: new Date().toISOString() };
  db.referrals.push(record);
  saveDB(db);
  const v = record.values || {};
  const subject = `Referral filed - ${v.staff || 'staff'}`;
  const body = [
    `Date: ${v.date || '-'}`,
    `Staff involved: ${v.staff || '-'}`,
    `What happened: ${v.whatHappened || '-'}`,
    `Verbally corrected: ${v.verbalCorrection || '-'}`,
    `Corrected after warning: ${v.correctedAfter || '-'}`,
    `Filed by: ${v.leadSignoff || '-'}`,
  ].join('\n');
  sendAlert(subject, body);
  res.json({ ok: true });
});

// ---------- websocket relay ----------
// Roles: 'admin' and 'guard' send push-to-talk clips and play/stop triggers.
// 'receiver' (the PC wired to the amp) plays them. Everything a sender sends
// gets relayed to every connected receiver.
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const role = url.searchParams.get('role'); // admin | guard | receiver
  const code = url.searchParams.get('code');

  const checkRole = role === 'receiver' ? 'admin' : role; // receiver PC authenticates with the admin code
  const expected = checkRole === 'admin' ? process.env.ADMIN_ACCESS_CODE : process.env.GUARD_ACCESS_CODE;
  if (expected && code !== expected) {
    ws.close(4001, 'Invalid access code');
    return;
  }

  ws.role = role;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (msg, isBinary) => {
    // Senders (admin/guard) talk to the receiver; the receiver talks back to senders
    // (now-playing status, etc). This keeps push-to-talk/play triggers one-way while
    // letting status flow the other way.
    const targetRoles = ws.role === 'receiver' ? ['admin', 'guard'] : ['receiver'];
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN && targetRoles.includes(client.role)) {
        client.send(msg, { binary: isBinary });
      }
    });
  });
});

// drop dead connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Facility dashboard listening on ${PORT}`));
