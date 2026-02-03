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
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;

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

app.set('trust proxy', 1);

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
  res.sendFile(path.join(__dirname, 'public', 'widget_detailed.html'));
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

  <p style="margin-top: 20px;">
    <a href="/widget_detailed.html" style="color: #3182ce; font-weight: bold; text-decoration: none;">
      Click HERE to view the widget
    </a>
  </p>

  <p style="margin-top: 30px;">
    You can close this window.
  </p>
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
  console.log('Data collection triggered');
  
  exec('node collect-data.js', (error, stdout) => {
    if (error) {
      console.error('Collection error:', error.message);
      return res.status(500).json({ success: false, error: error.message });
    }
    console.log('Collection completed:', stdout);
    res.json({ success: true, message: 'Data collection completed', output: stdout });
  });
});

// ============================================
// ADMIN AUTH ROUTES
// ============================================

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  
  console.log('Login attempt');
  
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    console.log('Login successful, session ID:', req.sessionID);
    res.json({ success: true, message: 'Login successful' });
  } else {
    console.log('Login failed: password mismatch');
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.json({ success: true, message: 'Logged out' });
  });
});

app.get('/api/admin/check', (req, res) => {
  console.log('Session check - isAdmin:', req.session?.isAdmin);
  res.json({ authenticated: !!req.session?.isAdmin });
});

// ============================================
// PROTECTED ADMIN ROUTES
// ============================================

// List all athletes with full details (admin only)
app.get('/api/athletes/list', requireAdminSession, async (req, res) => {
  try {
    const tokens = await readTokens();
    const athletes = Object.keys(tokens).map(id => ({
      athleteId: id,
      name: `${tokens[id].firstName} ${tokens[id].lastName}`,
      connectedAt: tokens[id].connectedAt
    }));
    res.json({ athletes });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list athletes' });
  }
});

// Remove an athlete by ID (admin only)
app.delete('/api/athletes/:athleteId', requireAdminSession, async (req, res) => {
  try {
    const { athleteId } = req.params;
    const tokens = await readTokens();
    
    if (!tokens[athleteId]) {
      return res.status(404).json({ error: 'Athlete not found' });
    }
    
    const athleteName = `${tokens[athleteId].firstName} ${tokens[athleteId].lastName}`;
    delete tokens[athleteId];
    await saveTokens(tokens);
    
    console.log(`Admin removed athlete: ${athleteName} (ID: ${athleteId})`);
    
    res.json({ 
      success: true, 
      message: `Removed athlete: ${athleteName}`,
      athleteId 
    });
  } catch (error) {
    console.error('Error removing athlete:', error);
    res.status(500).json({ error: 'Failed to remove athlete' });
  }
});

// ============================================
// SERVER START
// ============================================

app.listen(PORT, async () => {
  await initializeFiles();
  console.log(`\n=== Server Started ===`);
  console.log(`Port: ${PORT}`);
  console.log(`Storage: ${DATA_DIR}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Admin password set: ${ADMIN_PASSWORD !== 'change_this_password' ? 'Yes' : 'No (using default!)'}`);
  console.log(`\nAdmin panel: http://localhost:${PORT}/admin.html`);
  console.log(`Widget: http://localhost:${PORT}/widget.html`);
  console.log(`======================\n`);
});