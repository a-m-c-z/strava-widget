// Strava OAuth Authentication Server
// This handles friend authentication and stores their tokens

const express = require('express');
const session = require('express-session');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Strava API credentials
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID || 'YOUR_CLIENT_ID';
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;

// Admin authentication
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change_this_password';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret_key';

// =====================================================
// FILE STORAGE
// =====================================================
const DATA_DIR = __dirname;
const TOKENS_FILE = path.join(DATA_DIR, 'athlete_tokens.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Session middleware
const sessionOptions = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
};

if (process.env.NODE_ENV === 'production') {
  const FileStore = require('session-file-store')(session);
  sessionOptions.store = new FileStore({
    path: path.join(__dirname, 'sessions'),
    ttl: 86400
  });
}

app.use(session(sessionOptions));

// ============================================
// INITIALIZE DATA FILES
// ============================================
async function initializeFiles() {
  try { await fs.access(TOKENS_FILE); }
  catch { await fs.writeFile(TOKENS_FILE, JSON.stringify({})); }

  try { await fs.access(STATS_FILE); }
  catch {
    await fs.writeFile(STATS_FILE, JSON.stringify({
      totalDistance: 0,
      athletes: [],
      lastUpdated: null
    }));
  }
}

// Helpers
async function readTokens() {
  return JSON.parse(await fs.readFile(TOKENS_FILE, 'utf8'));
}

async function saveTokens(tokens) {
  await fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// Admin guard
function requireAdminSession(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// ============================================
// PUBLIC ROUTES
// ============================================

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html> ... (unchanged landing page) ...`);
});

// Strava OAuth routes (UNCHANGED)
app.get('/auth/strava', (req, res) => { /* unchanged */ });
app.get('/auth/callback', async (req, res) => { /* unchanged */ });

// ============================================
// PUBLIC API ROUTES
// ============================================

app.get('/api/stats', async (req, res) => {
  try {
    const data = await fs.readFile(STATS_FILE, 'utf8');
    const stats = JSON.parse(data);
    stats.mileTarget = parseFloat(process.env.MILE_TARGET) || 0;
    res.json(stats);
  } catch {
    res.status(500).json({ error: 'Failed to read stats' });
  }
});

app.get('/api/athletes', async (req, res) => {
  try {
    const tokens = await readTokens();
    const athletes = Object.values(tokens).map(t => ({
      name: `${t.firstName} ${t.lastName}`,
      connectedAt: t.connectedAt
    }));
    res.json({ count: athletes.length, athletes });
  } catch {
    res.status(500).json({ error: 'Failed to read athletes' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/trigger-collect', async (req, res) => {
  const { exec } = require('child_process');
  exec('node collect-data.js', (error, stdout) => {
    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    res.json({ success: true, output: stdout });
  });
});

// ============================================
// ADMIN AUTH ROUTES (USED NOW)
// ============================================

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid password' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/admin/check', (req, res) => {
  res.json({ authenticated: !!req.session.isAdmin });
});

// ============================================
// PROTECTED ADMIN ROUTES
// ============================================

app.get('/api/athletes/list', requireAdminSession, async (req, res) => {
  const tokens = await readTokens();
  res.json({
    athletes: Object.values(tokens).map(t => ({
      athleteId: t.athleteId,
      name: `${t.firstName} ${t.lastName}`,
      connectedAt: t.connectedAt
    }))
  });
});

app.delete('/api/athletes/:athleteId', requireAdminSession, async (req, res) => {
  const tokens = await readTokens();
  if (!tokens[req.params.athleteId]) {
    return res.status(404).json({ error: 'Athlete not found' });
  }
  delete tokens[req.params.athleteId];
  await saveTokens(tokens);
  res.json({ success: true });
});

// ============================================
// SERVER START
// ============================================

app.listen(PORT, async () => {
  await initializeFiles();
  console.log(`Server running on port ${PORT}`);
});
