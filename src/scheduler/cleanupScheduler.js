// Runs the data cleanup automatically: once shortly after the bot starts, then
// every day at 04:00 server time. Turn it off with: /cleanup settings auto:False

const cron = require('node-cron');
const { runCleanup, getConfig } = require('../cleanup');

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function runAuto(reason) {
  try {
    if (!getConfig().auto) return;
    const r = runCleanup();
    if (r.total > 0) {
      console.log(
        `🧹 Auto-cleanup (${reason}): trimmed ${r.mailBodies} mail texts, removed ${r.mailRecords} old mail records, ` +
          `${r.sharedKnown + r.personalKnown} old nation IDs, ${r.staleRecruits} stale recruits. ` +
          `Data file ${mb(r.sizeBefore)} -> ${mb(r.sizeAfter)}.`
      );
    }
  } catch (err) {
    console.error('❌ Auto-cleanup failed:', err.message);
  }
}

function startCleanupScheduler() {
  cron.schedule('0 4 * * *', () => runAuto('daily'));
  setTimeout(() => runAuto('startup'), 2 * 60 * 1000);
  console.log('🔄 Data cleanup scheduler started (runs 2 minutes after startup, then daily at 04:00).');
}

module.exports = { startCleanupScheduler };
