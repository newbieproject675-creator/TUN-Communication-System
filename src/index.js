// This is the file you run to start the bot: node src/index.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { syncCommands } = require('./commandRegistry');
const { startNewNationScanner } = require('./scheduler/newNationScanner');
const { startFollowUpScanner } = require('./scheduler/followUpScanner');
const { startAllianceExitScanner } = require('./scheduler/allianceExitScanner');
const { startApplicantScanner } = require('./scheduler/applicantScanner');
const { startEngagementScheduler } = require('./scheduler/engagementScanner');
const { startPersonalRecruitScanner } = require('./scheduler/personalRecruitScanner');

// Make sure required settings exist before we even try to start.
const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'PNW_API_KEY'];
for (const key of required) {
  if (!process.env[key] || process.env[key].startsWith('paste_')) {
    console.error(`❌ Missing or unfilled setting: ${key}. Check your .env file.`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
});

client.commands = new Collection();

// Load every command file in src/commands/
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));
for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
}

// Load every event file in src/events/
const eventsPath = path.join(__dirname, 'events');
for (const file of fs.readdirSync(eventsPath).filter((f) => f.endsWith('.js'))) {
  const event = require(path.join(eventsPath, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
}

async function deployCommands() {
  const commands = [...client.commands.values()].map((cmd) => cmd.data.toJSON());
  try {
    await syncCommands({
      commands,
      token: process.env.DISCORD_TOKEN,
      clientId: process.env.DISCORD_CLIENT_ID,
      guildId: process.env.DISCORD_GUILD_ID || null,
      force: process.env.FORCE_COMMAND_DEPLOY === 'true',
    });
  } catch (err) {
    // Never let a registration problem stop the bot's other features.
    console.error('⚠️ Failed to register slash commands:', err.message);
  }
}

client.once('clientReady', async () => {
  await deployCommands();

  startNewNationScanner(client);
  startFollowUpScanner(client);
  startAllianceExitScanner(client);
  startApplicantScanner(client);
  startEngagementScheduler(client);
  startPersonalRecruitScanner(client);
});

client.login(process.env.DISCORD_TOKEN);
