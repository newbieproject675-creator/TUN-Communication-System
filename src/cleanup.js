// Data cleanup: removes old data that is no longer needed so bot.json doesn't
// grow forever. Used by the daily automatic job and by the /cleanup command.
//
// WHAT IT TOUCHES (all adjustable with /cleanup settings):
//   1. Mail TEXT older than `mailBodiesDays`  -> the long message text is replaced
//      with a short note. The record itself (who/when/subject) stays, so your
//      mail history and totals are unchanged. (Messages are also posted in the
//      recruit's Discord thread, so nothing is lost there.)
//   2. Mail RECORDS older than `mailHistoryDays` -> removed, but they are still
//      counted in the lifetime "mails sent" total.
//   3. "Already seen" nation IDs older than `knownNationsDays` -> removed. Those
//      nations are far too old to ever show up as "new" again.
//   4. Stale recruits (OFF by default) -> recruits still at stage New/Rejected
//      with no notes and no assigned staff, untouched for `staleRecruitsDays`.
//
// WHAT IT NEVER TOUCHES: templates (shared and personal), settings, blacklist,
// API keys, personal recruit profiles, engagement campaigns/messages, departure
// tracking, and any recruit that is Joined / Interested / Interviewing / Invited /
// Blacklisted, has notes, or is assigned to someone.
//
// Before any real deletion a safety copy is saved as data/bot.json.pre-cleanup
// (overwritten each time, so only the latest one is kept).

const fs = require('fs');
const path = require('path');
const store = require('./store');
const db = require('./database');

const DAY_MS = 24 * 60 * 60 * 1000;
const BODY_PLACEHOLDER = '[message text removed by cleanup to save space]';
const STALE_STAGES = ['New', 'Rejected'];

const DEFAULTS = {
  auto: true,
  mailBodiesDays: 7,
  mailHistoryDays: 90,
  knownNationsDays: 30,
  staleRecruitsDays: 0, // 0 = off
};

function getConfig() {
  return { ...DEFAULTS, ...(db.getSetting('cleanupConfig') || {}) };
}

function saveConfig(patch) {
  const next = { ...getConfig(), ...patch };
  db.setSetting('cleanupConfig', next);
  return next;
}

function toTime(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function prettyBytes(data) {
  return Buffer.byteLength(JSON.stringify(data, null, 2));
}

// One pass over the data. With apply=false nothing is changed, it only counts.
function scan(data, cfg, now, apply) {
  const r = {
    mailBodies: 0,
    mailBodyBytes: 0,
    mailRecords: 0,
    mailRecordsOutgoing: 0,
    mailRecordsIncoming: 0,
    sharedKnown: 0,
    personalKnown: 0,
    staleRecruits: 0,
    estimatedBytes: 0,
  };

  const bodyCut = now - cfg.mailBodiesDays * DAY_MS;
  const histCut = now - cfg.mailHistoryDays * DAY_MS;
  const knownCut = now - cfg.knownNationsDays * DAY_MS;

  // --- Mail log ---
  const keep = [];
  for (const m of data.mailLog || []) {
    const ts = toTime(m.created_at);
    if (ts !== null && ts < histCut) {
      r.mailRecords++;
      if (m.direction === 'outgoing') r.mailRecordsOutgoing++;
      else r.mailRecordsIncoming++;
      r.estimatedBytes += 180 + (typeof m.message === 'string' ? m.message.length : 0);
      continue; // dropped
    }
    if (
      ts !== null &&
      ts < bodyCut &&
      typeof m.message === 'string' &&
      m.message.length > BODY_PLACEHOLDER.length &&
      m.message !== BODY_PLACEHOLDER
    ) {
      r.mailBodies++;
      r.mailBodyBytes += m.message.length - BODY_PLACEHOLDER.length;
      if (apply) m.message = BODY_PLACEHOLDER;
    }
    keep.push(m);
  }
  r.estimatedBytes += r.mailBodyBytes;
  if (apply && r.mailRecords > 0) {
    data.mailLog = keep;
    const prev = data.archivedMailCounts || { outgoing: 0, incoming: 0 };
    data.archivedMailCounts = {
      outgoing: (prev.outgoing || 0) + r.mailRecordsOutgoing,
      incoming: (prev.incoming || 0) + r.mailRecordsIncoming,
    };
  }

  // --- Known nation IDs (shared + each personal recruiter) ---
  const pruneKnown = (map) => {
    let n = 0;
    for (const [id, when] of Object.entries(map || {})) {
      const ts = toTime(when);
      if (ts !== null && ts < knownCut) {
        n++;
        if (apply) delete map[id];
      }
    }
    return n;
  };
  r.sharedKnown = pruneKnown(data.knownNationIds);
  for (const profile of Object.values(data.personalRecruitProfiles || {})) {
    r.personalKnown += pruneKnown(profile.knownNationIds);
  }
  r.estimatedBytes += (r.sharedKnown + r.personalKnown) * 40;

  // --- Stale recruits (optional) ---
  if (cfg.staleRecruitsDays > 0) {
    const staleCut = now - cfg.staleRecruitsDays * DAY_MS;
    for (const [id, rec] of Object.entries(data.recruits || {})) {
      if (!STALE_STAGES.includes(rec.stage)) continue;
      if (rec.notes || rec.assigned_staff_id) continue;
      const ts = toTime(rec.last_contacted_at || rec.created_at);
      if (ts === null || ts >= staleCut) continue;
      r.staleRecruits++;
      r.estimatedBytes += 350;
      if (apply) delete data.recruits[id];
    }
  }

  r.total = r.mailBodies + r.mailRecords + r.sharedKnown + r.personalKnown + r.staleRecruits;
  return r;
}

/**
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun]    Only report what would be removed
 * @param {object}  [opts.config]    One-off settings override
 * @param {number}  [opts.now]       Current time in ms (for testing)
 */
function runCleanup({ dryRun = false, config, now = Date.now() } = {}) {
  const cfg = { ...getConfig(), ...(config || {}) };
  const data = store.load();

  const sizeBefore = prettyBytes(data);
  const plan = scan(data, cfg, now, false);

  const report = { ...plan, dryRun, config: cfg, sizeBefore, sizeAfter: sizeBefore, snapshot: false };
  if (dryRun || plan.total === 0) return report;

  // Safety copy of what's on disk right now, then the real cleanup.
  try {
    store.flush();
    const snapshotPath = store.dbPath + '.pre-cleanup';
    fs.copyFileSync(store.dbPath, snapshotPath);
    report.snapshot = path.basename(snapshotPath);
  } catch (err) {
    console.warn('⚠️ Could not create pre-cleanup safety copy:', err.message);
  }

  scan(data, cfg, now, true);
  store.save(data);
  report.sizeAfter = prettyBytes(data);
  return report;
}

module.exports = { runCleanup, getConfig, saveConfig, DEFAULTS, STALE_STAGES };
