// OPTIONAL manual deploy: node src/deployCommands.js  (or: npm run deploy-commands)
// You normally don't need this anymore — the bot syncs its slash commands
// automatically every time it starts (see src/commandRegistry.js).
// Running this file always forces a fresh push.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { syncCommands } = require('./commandRegistry');

const commandsPath = path.join(__dirname, 'commands');
const commands = fs
  .readdirSync(commandsPath)
  .filter((file) => file.endsWith('.js'))
  .map((file) => require(path.join(commandsPath, file)).data.toJSON());

syncCommands({
  commands,
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID || null,
  force: true,
}).catch((error) => {
  console.error('❌ Failed to register commands:', error);
  process.exit(1);
});
