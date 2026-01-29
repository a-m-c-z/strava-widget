// Data Collection Script
// Run this periodically (e.g., with cron) to update distances

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const TOKENS_FILE = path.join(__dirname, 'athlete_tokens.json');
const STATS_FILE = path.join(__dirname, 'stats.json');

// IMPORTANT: Replace these with your Strava API credentials
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID || 'CLIENT_ID';
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET || 'CLIENT_SECRET';

// Configure your tracking period
const START_DATE = process.env.START_DATE || '2026-01-01'; // YYYY-MM-DD
const END_DATE = process.env.END_DATE || '2026-12-31'; // YYYY-MM-DD

// Read tokens
async function readTokens() {
    const data = await fs.readFile(TOKENS_FILE, 'utf8');
    return JSON.parse(data);
}

// Save tokens
async function saveTokens(tokens) {
    await fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// Refresh access token if expired
async function refreshAccessToken(athleteData) {
    const now = Math.floor(Date.now() / 1000);
    
    if (athleteData.expiresAt > now) {
        return athleteData.accessToken;
    }

    console.log(`Refreshing token for ${athleteData.firstName} ${athleteData.lastName}...`);
    
    try {
        const response = await axios.post('https://www.strava.com/oauth/token', {
            client_id: STRAVA_CLIENT_ID,
            client_secret: STRAVA_CLIENT_SECRET,
            refresh_token: athleteData.refreshToken,
            grant_type: 'refresh_token'
        });

        athleteData.accessToken = response.data.access_token;
        athleteData.refreshToken = response.data.refresh_token;
        athleteData.expiresAt = response.data.expires_at;

        return athleteData.accessToken;
    } catch (error) {
        console.error(`Failed to refresh token for athlete ${athleteData.athleteId}:`, error.response?.data || error.message);
        throw error;
    }
}

// Fetch activities for an athlete within the date range
async function fetchActivities(accessToken, startDate, endDate) {
    const startTimestamp = Math.floor(new Date(startDate).getTime() / 1000);
    const endTimestamp = Math.floor(new Date(endDate).getTime() / 1000);
    
    let allActivities = [];
    let page = 1;
    const perPage = 200;

    try {
        while (true) {
            const response = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                },
                params: {
                    after: startTimestamp,
                    before: endTimestamp,
                    page: page,
                    per_page: perPage
                }
            });

            if (response.data.length === 0) break;
            
            allActivities = allActivities.concat(response.data);
            
            if (response.data.length < perPage) break;
            page++;
        }

        return allActivities;
    } catch (error) {
        console.error('Error fetching activities:', error.response?.data || error.message);
        return [];
    }
}

// Calculate total distance for activities with breakdown by type
function calculateDistanceBreakdown(activities) {
    const breakdown = {
        total: 0,
        byType: {}
    };
    
    activities.forEach(activity => {
        const distance = (activity.distance || 0) / 1000; // Convert to km
        const type = activity.type || 'Other';
        
        breakdown.total += distance;
        
        if (!breakdown.byType[type]) {
            breakdown.byType[type] = {
                distance: 0,
                count: 0
            };
        }
        
        breakdown.byType[type].distance += distance;
        breakdown.byType[type].count += 1;
    });
    
    return breakdown;
}

// Legacy function for backwards compatibility
function calculateTotalDistance(activities) {
    return calculateDistanceBreakdown(activities).total;
}

// Main collection function
async function collectData() {
    console.log('Starting data collection...');
    console.log(`Tracking period: ${START_DATE} to ${END_DATE}`);

    try {
        const tokens = await readTokens();
        const athleteIds = Object.keys(tokens);

        if (athleteIds.length === 0) {
            console.log('No athletes connected yet.');
            return;
        }

        console.log(`Found ${athleteIds.length} connected athletes`);

        let totalDistance = 0;
        const athleteStats = [];
        const activityTypeBreakdown = {};

        for (const athleteId of athleteIds) {
            const athleteData = tokens[athleteId];
            console.log(`Processing ${athleteData.firstName} ${athleteData.lastName}...`);

            try {
                // Refresh token if needed
                const accessToken = await refreshAccessToken(athleteData);
                
                // Fetch activities
                const activities = await fetchActivities(accessToken, START_DATE, END_DATE);
                console.log(`  Found ${activities.length} activities`);

                // Calculate distance with breakdown
                const breakdown = calculateDistanceBreakdown(activities);
                console.log(`  Total distance: ${breakdown.total.toFixed(2)} km`);

                totalDistance += breakdown.total;
                
                athleteStats.push({
                    name: `${athleteData.firstName} ${athleteData.lastName}`,
                    distance: breakdown.total,
                    activityCount: activities.length,
                    byType: breakdown.byType
                });
                
                // Aggregate activity types
                Object.keys(breakdown.byType).forEach(type => {
                    if (!activityTypeBreakdown[type]) {
                        activityTypeBreakdown[type] = {
                            distance: 0,
                            count: 0
                        };
                    }
                    activityTypeBreakdown[type].distance += breakdown.byType[type].distance;
                    activityTypeBreakdown[type].count += breakdown.byType[type].count;
                });

            } catch (error) {
                console.error(`Error processing athlete ${athleteId}:`, error.message);
            }
        }

        // Save updated tokens (in case we refreshed any)
        await saveTokens(tokens);

        // Sort athletes by distance
        athleteStats.sort((a, b) => b.distance - a.distance);

        // Save stats
        const stats = {
            totalDistance: totalDistance,
            totalDistanceMiles: totalDistance * 0.621371,
            athletes: athleteStats,
            athleteCount: athleteStats.length,
            activityTypeBreakdown: activityTypeBreakdown,
            lastUpdated: new Date().toISOString(),
            trackingPeriod: {
                start: START_DATE,
                end: END_DATE
            }
        };

        await fs.writeFile(STATS_FILE, JSON.stringify(stats, null, 2));
        
        console.log('\n=== Summary ===');
        console.log(`Total Distance: ${totalDistance.toFixed(2)} km (${stats.totalDistanceMiles.toFixed(2)} miles)`);
        console.log(`Athletes: ${athleteStats.length}`);
        console.log('\n=== Distance by Activity Type ===');
        Object.keys(activityTypeBreakdown).sort((a, b) => 
            activityTypeBreakdown[b].distance - activityTypeBreakdown[a].distance
        ).forEach(type => {
            const typeData = activityTypeBreakdown[type];
            console.log(`  ${type}: ${typeData.distance.toFixed(2)} km (${typeData.count} activities)`);
        });
        console.log('\nStats saved successfully!');

    } catch (error) {
        console.error('Error in data collection:', error);
    }
}

// Run the collection
collectData();