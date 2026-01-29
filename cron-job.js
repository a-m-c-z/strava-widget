// Automatic Data Collection via Cron
// Include this in your server.js or run separately

const cron = require('node-cron');
const { exec } = require('child_process');
const path = require('path');

// Run data collection every hour
// Cron format: minute hour day month weekday
// '0 * * * *' = every hour at minute 0
// '*/30 * * * *' = every 30 minutes
// '0 */2 * * *' = every 2 hours

const SCHEDULE = process.env.CRON_SCHEDULE || '0 * * * *';

console.log(`Scheduling automatic data collection: ${SCHEDULE}`);

cron.schedule(SCHEDULE, () => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Running scheduled data collection...`);
    
    exec('node collect-data.js', (error, stdout, stderr) => {
        if (error) {
            console.error(`[${timestamp}] Error in data collection:`, error.message);
            return;
        }
        if (stderr) {
            console.error(`[${timestamp}] Stderr:`, stderr);
        }
        console.log(`[${timestamp}] Collection complete:`);
        console.log(stdout);
    });
});

// Run immediately on startup
console.log('Running initial data collection...');
exec('node collect-data.js', (error, stdout, stderr) => {
    if (error) {
        console.error('Error in initial collection:', error.message);
        return;
    }
    console.log('Initial collection complete');
    console.log(stdout);
});

console.log('Cron job is running. Press Ctrl+C to stop.');

// If running standalone
if (require.main === module) {
    // Keep the process running
    process.stdin.resume();
}

module.exports = { SCHEDULE };