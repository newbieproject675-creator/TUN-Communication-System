// Personal Recruit Scanner
//
// Runs every 5 minutes. Every staff member who has
//   a) personal auto-recruit turned ON
//   b) a personal API key registered
//   c) at least one personal 'initial' template
// is processed INDEPENDENTLY and IN PARALLEL:
//
//   - Each recruiter has their own "already mailed" list and their own send
//     cap, so one recruiter never uses up another recruiter's nations or quota.
//   - The shared alliance scanner no longer blocks personal recruiters (and
//     vice versa). The same nation can receive mail from several recruiters.
//   - Mail is sent with that recruiter's own API key, so each key has its own
//     PnW rate limit instead of everyone queueing behind one another.
//   - The list of recent nations is fetched ONCE per cycle and shared.
//
// Tuning (all optional, set as environment variables):
//   PERSONAL_MAX_PER_RUN     max mails per recruiter per 5-min run   (default 50)
//   PERSONAL_SEND_DELAY_MS   pause between one recruiter's mails     (default 1500)
//   PERSONAL_SCAN_WINDOW     how many newest nations to look at      (default 100)

const cron = require('node-cron');
const { EmbedBuilder } = require('discord.js');
const pnw = require('../pnwApi');
const db = require('../database');
const prDb = require('../personalRecruitDb');
const { getOrCreateRecruitThread } = require('../utils/threads');
const { truncateForDiscord } = require('../utils/discordText');

function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_PER_RUN = intEnv('PERSONAL_MAX_PER_RUN', 50);
const DELAY_MS = intEnv('PERSONAL_SEND_DELAY_MS', 1500);
const SCAN_WINDOW = intEnv('PERSONAL_SCAN_WINDOW', 100);

// Errors that mean "stop this recruiter's run now" (bad/blocked key, rate limit)
// rather than "this one nation failed".
const FATAL_ERROR = /api key|invalid key|unauthori[sz]ed|forbidden|rate limit|too many|slow down|banned|disabled/i;

// A recruiter whose previous run is still going is skipped, never run twice at once.
const running = new Set();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fillTemplate(text, nation) {
  return text
    .replaceAll('{nation_name}', nation.nation_name)
    .replaceAll('{leader_name}', nation.leader_name)
    .replaceAll('{nation}', nation.nation_name)
    .replaceAll('{leader}', nation.leader_name);
}

async function runPersonalScanForStaff(userId, client, candidates, logChannel) {
  if (running.has(userId)) return;
  running.add(userId);

  try {
    const profile = prDb.getProfile(userId);
    if (!profile || !profile.autoRecruitEnabled) return;

    const apiKey = db.getPersonalApiKey(userId);
    if (!apiKey) {
      console.warn(`⚠️ Personal auto-recruit: user ${userId} has auto-recruit ON but no API key registered. Skipping.`);
      return;
    }

    if (prDb.getPersonalTemplatesByType(userId, 'initial').length === 0) {
      console.warn(`⚠️ Personal auto-recruit: user ${userId} has no 'initial' templates. Skipping.`);
      return;
    }

    // Only THIS recruiter's own history matters.
    const fresh = candidates.filter((n) => !prDb.isPersonalKnownNation(userId, n.id));
    if (fresh.length === 0) return;

    // Blacklisted nations are never mailed and never count against the cap.
    const blacklisted = fresh.filter((n) => db.isBlacklisted(n.id));
    if (blacklisted.length > 0) prDb.markPersonalNationsKnown(userId, blacklisted.map((n) => n.id));
    const mailable = fresh.filter((n) => !db.isBlacklisted(n.id));

    // Anything past the cap is left UNmarked, so it's picked up on the next run
    // instead of being silently lost.
    const batch = mailable.slice(0, MAX_PER_RUN);
    let sentCount = 0;

    for (const nation of batch) {
      const template = prDb.getRandomPersonalTemplate(userId, 'initial');
      if (!template) break;

      // Mark known BEFORE sending so a crash mid-send can never cause a double-send.
      prDb.markPersonalNationKnown(userId, nation.id);

      const subject = fillTemplate(template.subject, nation);
      const body = fillTemplate(template.body, nation);

      try {
        await pnw.sendMail(nation.id, subject, body, apiKey);
      } catch (err) {
        console.error(`❌ Personal auto-recruit (${userId}) failed for #${nation.id}: ${err.message}`);
        if (FATAL_ERROR.test(err.message)) {
          console.warn(`⏸️ Personal auto-recruit (${userId}) stopping this run: ${err.message}`);
          break;
        }
        continue;
      }

      db.addMailLog({
        nationId: nation.id,
        direction: 'outgoing',
        subject,
        message: body,
        sentBy: userId,
      });
      db.touchLastContacted(nation.id);
      sentCount++;

      if (logChannel) {
        try {
          const thread = await getOrCreateRecruitThread(client, nation.id, nation.nation_name);
          const embed = new EmbedBuilder()
            .setTitle('🎯 PERSONAL AUTO-RECRUIT SENT')
            .addFields(
              { name: 'Nation', value: `${nation.nation_name} (#${nation.id})` },
              { name: 'Template', value: template.id },
              { name: 'Recruiter', value: `<@${userId}>` }
            )
            .setColor(0xe67e22)
            .setTimestamp();
          await thread.send({ embeds: [embed] });
          await thread.send({ content: truncateForDiscord(body, '**Message:**\n') });
        } catch (err) {
          console.error(`❌ Could not log personal auto-recruit thread: ${err.message}`);
        }
      }

      await sleep(DELAY_MS);
    }

    if (sentCount > 0) {
      console.log(`✅ Personal auto-recruit (${userId}): mailed ${sentCount} nation(s).`);
    }
  } finally {
    running.delete(userId);
  }
}

async function runAllPersonalScanners(client) {
  const active = prDb.getAllProfiles().filter((p) => p.autoRecruitEnabled);
  if (active.length === 0) return;

  let candidates;
  try {
    candidates = await pnw.getRecentUnalignedNations(SCAN_WINDOW);
  } catch (err) {
    console.error(`❌ Personal auto-recruit: failed to fetch nations: ${err.message}`);
    return;
  }
  if (candidates.length === 0) return;

  const logChannelId = db.getMailLogChannelId();
  const logChannel = logChannelId ? await client.channels.fetch(logChannelId).catch(() => null) : null;

  // All recruiters run at the same time, each fully independent of the others.
  await Promise.allSettled(
    active.map((profile) =>
      runPersonalScanForStaff(profile.userId, client, candidates, logChannel).catch((err) =>
        console.error(`❌ Personal auto-recruit crashed for ${profile.userId}:`, err.message)
      )
    )
  );
}

function startPersonalRecruitScanner(client) {
  cron.schedule('*/5 * * * *', () => {
    runAllPersonalScanners(client).catch((err) =>
      console.error('❌ Personal recruit scanner error:', err.message)
    );
  });
  console.log(`🔄 Personal recruit scanner started (every 5 minutes, up to ${MAX_PER_RUN} mails per recruiter per run, recruiters run in parallel).`);
}

module.exports = { startPersonalRecruitScanner, runAllPersonalScanners };
