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

// File storage - use persistent disk in production, local files in development
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/data' : __dirname;
const TOKENS_FILE = path.join(DATA_DIR, 'athlete_tokens.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Session middleware for admin authentication
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // HTTPS in production
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Initialize data files if they don't exist
async function initializeFiles() {
    try {
        await fs.access(TOKENS_FILE);
    } catch {
        await fs.writeFile(TOKENS_FILE, JSON.stringify({}));
    }
    try {
        await fs.access(STATS_FILE);
    } catch {
        await fs.writeFile(STATS_FILE, JSON.stringify({ totalDistance: 0, athletes: [], lastUpdated: null }));
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
// PUBLIC ROUTES (No authentication required)
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
                <img src="https://developers.strava.com/images/btn_strava_connectwith_orange.svg" alt="Connect with Strava" style="vertical-align: middle;">
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
    const authUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${REDIRECT_URI}&approval_prompt=force&scope=activity:read_all`;
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
        // Exchange authorization code for access token
        const tokenResponse = await axios.post('https://www.strava.com/oauth/token', {
            client_id: STRAVA_CLIENT_ID,
            client_secret: STRAVA_CLIENT_SECRET,
            code: code,
            grant_type: 'authorization_code'
        });

        const { access_token, refresh_token, expires_at, athlete } = tokenResponse.data;

        // Store athlete tokens
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
    } catch (error) {
        console.error('Error exchanging token:', error.response?.data || error.message);
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

// API endpoint to get current stats (for the widget)
app.get('/api/stats', async (req, res) => {
    try {
        const data = await fs.readFile(STATS_FILE, 'utf8');
        const stats = JSON.parse(data);
        // Attach the mile target from environment so the widget can use it
        stats.mileTarget = parseFloat(process.env.MILE_TARGET) || 0;
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: 'Failed to read stats' });
    }
});

// API endpoint to list connected athletes (basic info only)
app.get('/api/athletes', async (req, res) => {
    try {
        const tokens = await readTokens();
        const athletes = Object.values(tokens).map(t => ({
            name: `${t.firstName} ${t.lastName}`,
            connectedAt: t.connectedAt
        }));
        res.json({ count: athletes.length, athletes });
    } catch (error) {
        res.status(500).json({ error: 'Failed to read athletes' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Manual trigger endpoint for data collection (public for cron services)
app.get('/api/trigger-collect', async (req, res) => {
    const { exec } = require('child_process');
    console.log('Data collection triggered');
    
    exec('node collect-data.js', (error, stdout, stderr) => {
        if (error) {
            console.error('Collection error:', error.message);
            return res.status(500).json({ 
                success: false, 
                error: error.message 
            });
        }
        console.log('Collection completed:', stdout);
        res.json({ 
            success: true, 
            message: 'Data collection completed',
            output: stdout 
        });
    });
});

// ============================================
// ADMIN AUTHENTICATION ROUTES
// ============================================

// Admin login endpoint
app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    
    if (password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        res.json({ success: true, message: 'Login successful' });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

// Admin logout endpoint
app.post('/api/admin/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to logout' });
        }
        res.json({ success: true, message: 'Logged out' });
    });
});

// Check if user is authenticated
app.get('/api/admin/check', (req, res) => {
    res.json({ authenticated: !!req.session.isAdmin });
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
// SERVER STARTUP
// ============================================

// Start server
app.listen(PORT, async () => {
    await initializeFiles();
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`\n=== Configuration ===`);
    console.log(`Strava Client ID: ${STRAVA_CLIENT_ID === 'YOUR_CLIENT_ID' ? '⚠️  NOT SET' : '✓ Set'}`);
    console.log(`Admin Password: ${ADMIN_PASSWORD === 'change_this_password' ? '⚠️  Using default (CHANGE THIS!)' : '✓ Set'}`);
    console.log(`\n=== Admin Panel ===`);
    console.log(`Visit: http://localhost:${PORT}/admin.html`);
    console.log(`Password: ${ADMIN_PASSWORD === 'change_this_password' ? 'change_this_password (INSECURE!)' : '[Set via ADMIN_PASSWORD env var]'}`);
    
    // Start cron job for automatic data collection (optional)
    if (process.env.ENABLE_CRON === 'true') {
        console.log('\n=== Automatic Collection ===');
        console.log('Starting automatic data collection...');
        require('./cron-job');
    } else {
        console.log('\n=== Manual Collection ===');
        console.log('Automatic collection disabled.');
        console.log('Set ENABLE_CRON=true to enable, or use /api/trigger-collect endpoint');
    }
});