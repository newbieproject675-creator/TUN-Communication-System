// /help - Categorised, button-based interactive help menu.
// Self-updating: command detail text is generated live from loaded commands.
// Categories are defined here — add new commands to the right category
// when new commands are introduced.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');

const FIELD_LIMIT = 1024;

const CATEGORIES = [
  {
    id: 'mail',
    label: 'Mail',
    emoji: '📨',
    color: 0x3498db,
    commands: ['mail', 'reply'],
    description: 'Send and track in-game mail with nations',
  },
  {
    id: 'recruitment',
    label: 'Recruitment',
    emoji: '🎯',
    color: 0xf1c40f,
    commands: ['recruit', 'blacklist', 'myrecruit'],
    description: 'Shared recruitment system, pipeline, CRM, and personal auto-recruit',
  },
  {
    id: 'engagement',
    label: 'Engagement',
    emoji: '📚',
    color: 0x9b59b6,
    commands: ['engagement'],
    description: 'Automated member engagement and training campaigns',
  },
  {
    id: 'communications',
    label: 'Communications',
    emoji: '📢',
    color: 0x2ecc71,
    commands: ['dm', 'announce', 'announce-edit', 'cancel'],
    description: 'Discord DMs, channel announcements and editing',
  },
  {
    id: 'admin',
    label: 'Admin',
    emoji: '⚙️',
    color: 0xe74c3c,
    commands: ['config', 'config-status', 'apikey', 'admin-recruit', 'backup'],
    description: 'Bot configuration, API keys, admin tools and backups',
  },
];

function describeCommandLines(command) {
  const json = command.data.toJSON();
  const lines = [];
  const subcommands = [];
  const groups = [];

  for (const opt of json.options || []) {
    if (opt.type === 1) subcommands.push(opt);
    else if (opt.type === 2) groups.push(opt);
  }

  if (subcommands.length === 0 && groups.length === 0) {
    const optionList = (json.options || [])
      .map((o) => `${o.required ? '' : '[optional] '}${o.name}`)
      .join(', ');
    lines.push(`\`/${json.name}${optionList ? ' ' + optionList : ''}\` — ${json.description}`);
    return lines;
  }

  for (const sub of subcommands) {
    const optionList = (sub.options || [])
      .map((o) => `${o.required ? '' : '[optional] '}${o.name}`)
      .join(' ');
    lines.push(`\`/${json.name} ${sub.name}${optionList ? ' ' + optionList : ''}\` — ${sub.description}`);
  }

  for (const group of groups) {
    for (const sub of group.options || []) {
      const optionList = (sub.options || [])
        .map((o) => `${o.required ? '' : '[optional] '}${o.name}`)
        .join(' ');
      lines.push(`\`/${json.name} ${group.name} ${sub.name}${optionList ? ' ' + optionList : ''}\` — ${sub.description}`);
    }
  }

  return lines;
}

function packLinesIntoChunks(lines, limit = FIELD_LIMIT) {
  const chunks = [];
  let current = '';
  for (let line of lines) {
    if (line.length > limit) line = line.slice(0, limit - 3) + '...';
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function buildCategoryEmbed(category, allCommands) {
  const embed = new EmbedBuilder()
    .setTitle(`${category.emoji} ${category.label} Commands`)
    .setDescription(category.description)
    .setColor(category.color);

  for (const cmdName of category.commands) {
    const command = allCommands.get(cmdName);
    if (!command) continue;

    const lines = describeCommandLines(command);
    const chunks = packLinesIntoChunks(lines);
    chunks.forEach((chunk, i) => {
      embed.addFields({
        name: i === 0 ? `/${command.data.name}` : `/${command.data.name} (cont'd)`,
        value: chunk,
      });
    });
  }

  return embed;
}

function buildHomeEmbed() {
  return new EmbedBuilder()
    .setTitle('📖  TUN PnW Mailing Bot — Help')
    .setDescription(
      'Click a category button below to see its commands.\n\n' +
        CATEGORIES.map((c) => `${c.emoji} **${c.label}** — ${c.description}`).join('\n')
    )
    .setColor(0x3498db)
    .setFooter({ text: 'Click a category button to see its commands' });
}

function buildButtons(activeCategoryId = null) {
  const row = new ActionRowBuilder();
  for (const cat of CATEGORIES) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`help_cat_${cat.id}`)
        .setLabel(cat.label)
        .setEmoji(cat.emoji)
        .setStyle(cat.id === activeCategoryId ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );
  }
  return row;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available bot commands'),

  async execute(interaction) {
    const allCommands = interaction.client.commands;
    const homeEmbed = buildHomeEmbed();
    const row = buildButtons();

    const response = await interaction.reply({
      embeds: [homeEmbed],
      components: [row],
      flags: 64,
    });

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id,
      time: 5 * 60 * 1000,
    });

    collector.on('collect', async (btnInteraction) => {
      const catId = btnInteraction.customId.replace('help_cat_', '');
      const category = CATEGORIES.find((c) => c.id === catId);
      if (!category) return;

      const catEmbed = buildCategoryEmbed(category, allCommands);
      const updatedRow = buildButtons(catId);
      await btnInteraction.update({ embeds: [catEmbed], components: [updatedRow] });
    });

    collector.on('end', async () => {
      const disabledRow = new ActionRowBuilder().addComponents(
        CATEGORIES.map((cat) =>
          new ButtonBuilder()
            .setCustomId(`help_cat_${cat.id}`)
            .setLabel(cat.label)
            .setEmoji(cat.emoji)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
        )
      );
      await interaction.editReply({ components: [disabledRow] }).catch(() => {});
    });
  },
};
