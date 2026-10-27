// Keeps Discord's slash commands in sync with the command files in src/commands/.
//
// How it works:
//   1. We build a fingerprint (SHA-256) of every command definition plus the
//      target (which application + guild/global).
//   2. If that fingerprint matches the one saved from the last successful
//      registration, we do NOTHING (zero API calls).
//   3. If it differs (a command was added, removed or edited, or you changed
//      DISCORD_GUILD_ID), we push the full list to Discord ONE time and save the
//      new fingerprint. Failed pushes are never saved, so they retry next boot.
//
// The fingerprint is stored in data/command-registry.json. If that file is lost
// (e.g. a host with no persistent disk), the only consequence is one harmless
// re-registration on the next start. Set FORCE_COMMAND_DEPLOY=true to force a push.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { REST, Routes } = require('discord.js');

const STATE_PATH = path.join(__dirname, '..', 'data', 'command-registry.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

function routeFor(clientId, guildId) {
  return guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);
}

/**
 * @param {object}   opts
 * @param {object[]} opts.commands  Array of command.data.toJSON() results
 * @param {string}   opts.token     Bot token
 * @param {string}   opts.clientId  Application (client) ID
 * @param {string}  [opts.guildId]  If set, register to that guild only (instant). Otherwise global.
 * @param {boolean} [opts.force]    Push even if nothing changed
 * @returns {Promise<{changed: boolean, count: number}>}
 */
async function syncCommands({ commands, token, clientId, guildId, force = false }) {
  const payload = [...commands].sort((a, b) => a.name.localeCompare(b.name));
  const scope = guildId ? `guild:${guildId}` : 'global';
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify({ clientId, scope, payload }))
    .digest('hex');

  const state = readState();
  if (!force && state.fingerprint === fingerprint) {
    console.log(`✅ Slash commands already up to date (${payload.length}, ${scope}) — nothing to register.`);
    return { changed: false, count: payload.length };
  }

  const rest = new REST().setToken(token);

  // If the target changed (e.g. guild -> global), clear the old target so
  // players don't see every command twice.
  if (state.scope && state.scope !== scope && state.clientId === clientId) {
    const oldGuildId = state.scope.startsWith('guild:') ? state.scope.slice(6) : null;
    try {
      await rest.put(routeFor(clientId, oldGuildId), { body: [] });
      console.log(`🧹 Cleared old slash commands from previous target (${state.scope}).`);
    } catch (err) {
      console.warn(`⚠️ Could not clear old slash commands from ${state.scope}: ${err.message}`);
    }
  }

  await rest.put(routeFor(clientId, guildId), { body: payload });
  writeState({
    fingerprint,
    scope,
    clientId,
    commandCount: payload.length,
    updatedAt: new Date().toISOString(),
  });
  console.log(`✅ Registered ${payload.length} slash command(s) to ${scope}.`);
  return { changed: true, count: payload.length };
}

module.exports = { syncCommands };
