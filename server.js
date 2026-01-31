// Strava OAuth Authentication Server
// This handles friend authentication and stores their tokens

const express = require('express');
const session = require('express-session');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// IMPORTANT: Replace these with your Strava API credentials
// Get them from: https://www.strava.com/settings/api
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID || 'YOUR_CLIENT_ID';
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
const REDIRECT_URI =
  process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;

// Admin authentication
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change_this_password';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret_key';

// =====================================================
// FILE STORAGE (Render free-tier safe: project directory)
// =====================================================
const DATA_DIR = __dirname;
const TOKENS_FILE = path.join(DATA_DIR, 'athlete_tokens.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Session middleware for admin authentication
const sessionOptions = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
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
  try {
    await fs.access(TOKENS_FILE);
  } catch {
    await fs.writeFile(TOKENS_FILE, JSON.stringify({}));
  }

  try {
    await fs.access(STATS_FILE);
  } catch {
    await fs.writeFile(
      STATS_FILE,
      JSON.stringify({
        totalDistance: 0,
        athletes: [],
        lastUpdated: null
      })
    );
  }
}

// Read athlete tokens
async function readTokens() {
  const data = await fs.readFile(TOKENS_FILE, 'utf8');
  return JSON.parse(data);
}

// Save athlete tokens
async function saveTokens(tokens) {
  await fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// Admin authentication middleware
function requireAdminSession(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// ============================================
// PUBLIC ROUTES
// ============================================

// Root page - landing page for friends
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Strava Challenge Tracker</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      max-width: 600px;
      margin: 50px auto;
      padding: 20px;
      text-align: center;
    }
    .connect-btn {
      background-color: #FC4C02;
      color: white;
      padding: 15px 30px;
      border: none;
      border-radius: 5px;
      font-size: 18px;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
      margin-top: 20px;
    }
    .connect-btn:hover {
      background-color: #E34402;
    }
  </style>
</head>
<body>
  <h1>Join Our Strava Challenge!</h1>
  <p>Connect your Strava account to contribute to our fundraising goal.</p>
  <a href="/auth/strava" class="connect-btn">
    <img src="https://developers.strava.com/images/btn_strava_connectwith_orange.svg"
         alt="Connect with Strava"
         style="vertical-align: middle;">
  </a>
  <p style="margin-top: 30px; font-size: 12px; color: #666;">
    By connecting, you allow us to read your activity data to track our collective distance.
  </p>
</body>
</html>
`);
});

// Initiate Strava OAuth flow
app.get('/auth/strava', (req, res) => {
  const authUrl =
    `https://www.strava.com/oauth/authorize` +
    `?client_id=${STRAVA_CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${REDIRECT_URI}` +
    `&approval_prompt=force` +
    `&scope=activity:read_all`;

  res.redirect(authUrl);
});

// OAuth callback handler
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.send(`
<html>
<body style="font-family: Arial; text-align: center; padding: 50px;">
  <h2>Authorization Failed</h2>
  <p>You denied access or an error occurred.</p>
  <a href="/">Try Again</a>
</body>
</html>
`);
  }

  try {
    const tokenResponse = await axios.post(
      'https://www.strava.com/oauth/token',
      {
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code'
      }
    );

    const { access_token, refresh_token, expires_at, athlete } =
      tokenResponse.data;

    const tokens = await readTokens();
    tokens[athlete.id] = {
      athleteId: athlete.id,
      firstName: athlete.firstname,
      lastName: athlete.lastname,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: expires_at,
      connectedAt: new Date().toISOString()
    };

    await saveTokens(tokens);

    res.send(`
<html>
<body style="font-family: Arial; text-align: center; padding: 50px;">
  <h2>Successfully Connected!</h2>
  <p>Welcome, ${athlete.firstname}! Your activities will now be tracked.</p>
  <p>You can close this window.</p>
</body>
</html>
`);
  } catch (err) {
    console.error('Error exchanging token:', err.response?.data || err.message);
    res.status(500).send(`
<html>
<body style="font-family: Arial; text-align: center; padding: 50px;">
  <h2>Error</h2>
  <p>Failed to connect to Strava. Please try again.</p>
  <a href="/">Go Back</a>
</body>
</html>
`);
  }
});

// ============================================
// API ROUTES
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
// ADMIN AUTH
// ============================================

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/admin/check', (req, res) => {
  res.json({ authenticated: !!req.session.isAdmin });
});

// ============================================
// SERVER START
// ============================================

app.listen(PORT, async () => {
  await initializeFiles();
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Storage directory:', DATA_DIR);
});
