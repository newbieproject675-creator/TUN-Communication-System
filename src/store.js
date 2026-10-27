// Shared in-memory store for data/bot.json.
//
// WHY THIS EXISTS: every database function used to re-read AND re-write the whole
// bot.json file synchronously. While that happens Node can't answer anything else,
// so with lots of mail going out, Discord interactions (like /help) sat waiting
// longer than Discord's 3-second limit and failed with "Unknown interaction".
//
// NOW: the file is read ONCE, kept in memory, and written back to disk at most
// twice a second (atomically, so it can never be half-written). It's also flushed
// immediately when the bot shuts down, so Railway redeploys don't lose data.
//
// database.js, personalRecruitDb.js, engagementDb.js and backup.js all use this
// same store, so they always see each other's changes.

const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'bot.json');
const dbDir = path.dirname(dbPath);
const WRITE_DELAY_MS = 500;

let cache = null;
let timer = null;

function defaultData() {
  return {
    recruits: {},
    mailLog: [],
    knownNationIds: {},
    knownDepartureIds: {},
    templates: {},
    blacklist: {},
    personalApiKeys: {},
    settings: {
      autoRecruitEnabled: false,
    },
  };
}

function writeToDisk(data) {
  fs.mkdirSync(dbDir, { recursive: true });
  const tmpPath = dbPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, dbPath);
}

function readFromDisk() {
  if (!fs.existsSync(dbPath)) {
    const initial = defaultData();
    writeToDisk(initial);
    return initial;
  }

  let raw;
  try {
    raw = fs.readFileSync(dbPath, 'utf8');
  } catch (err) {
    console.error('❌ Could not read data file, starting fresh:', err.message);
    const initial = defaultData();
    writeToDisk(initial);
    return initial;
  }

  try {
    // Fill in any new fields that didn't exist in older versions of the data file.
    return { ...defaultData(), ...JSON.parse(raw) };
  } catch (err) {
    // File is corrupted (e.g. partial write during a crash).
    // Back it up so data isn't lost, then start fresh rather than crashing.
    const backupPath = dbPath + '.corrupted.' + Date.now();
    console.error(
      `❌ data/bot.json is corrupted (${err.message}). ` +
        `Backing up to ${backupPath} and starting fresh. ` +
        `You can restore from a /backup snapshot if you have one.`
    );
    try {
      fs.copyFileSync(dbPath, backupPath);
    } catch (backupErr) {
      console.error('⚠️ Could not back up corrupted file:', backupErr.message);
    }
    const initial = defaultData();
    writeToDisk(initial);
    return initial;
  }
}

/** Returns the live data object (loaded from disk the first time only). */
function load() {
  if (cache === null) cache = readFromDisk();
  return cache;
}

/** Call after changing the data. The disk write is batched. */
function save(data) {
  if (data) cache = data;
  if (timer) return;
  timer = setTimeout(flush, WRITE_DELAY_MS);
}

/** Writes any pending changes to disk right now. */
function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (cache === null) return;
  try {
    writeToDisk(cache);
  } catch (err) {
    console.error('❌ Could not write data/bot.json:', err.message);
    // Try again shortly rather than silently losing the changes.
    timer = setTimeout(flush, 5000);
  }
}

/** Throws away the in-memory copy so the next load() re-reads the file (used after /backup restore). */
function reload() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  cache = null;
}

// Make sure nothing is lost when the host stops or redeploys the bot.
process.on('exit', () => {
  if (timer) flush();
});
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => process.exit(0)); // triggers the 'exit' handler above
}

module.exports = { load, save, flush, reload, dbPath };
