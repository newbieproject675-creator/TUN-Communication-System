// /cleanup preview   - shows what old data would be removed (deletes nothing)
// /cleanup run       - removes it now
// /cleanup settings  - view or change how long data is kept, and turn the daily auto-cleanup on/off
// Admin only. Templates, settings, blacklist, API keys and active recruits are never touched.

const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const { runCleanup, getConfig, saveConfig, STALE_STAGES } = require('../cleanup');
const db = require('../database');

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function n(num) {
  return Number(num).toLocaleString('en-US');
}

function describePlan(r) {
  const c = r.config;
  const lines = [
    `• Mail text older than ${c.mailBodiesDays}d: **${n(r.mailBodies)}** mails trimmed (~${mb(r.mailBodyBytes)})`,
    `• Mail records older than ${c.mailHistoryDays}d: **${n(r.mailRecords)}** removed (still counted in your lifetime total)`,
    `• Old "already seen" nation IDs (${c.knownNationsDays}d+): **${n(r.sharedKnown + r.personalKnown)}**`,
    c.staleRecruitsDays > 0
      ? `• Stale ${STALE_STAGES.join('/')} recruits (${c.staleRecruitsDays}d+, no notes, unassigned): **${n(r.staleRecruits)}**`
      : '• Stale recruits: **off**',
  ];
  return lines.join('\n');
}

const NEVER_TOUCHED =
  '🔒 Never touched: templates, settings, blacklist, API keys, engagement campaigns, and any active/joined recruit.';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cleanup')
    .setDescription('Remove old data to keep the bot fast (Admin only)')
    .addSubcommand((sub) =>
      sub.setName('preview').setDescription('See what would be removed — deletes nothing')
    )
    .addSubcommand((sub) =>
      sub.setName('run').setDescription('Remove old data now (a safety copy is saved first)')
    )
    .addSubcommand((sub) =>
      sub
        .setName('settings')
        .setDescription('View or change how long data is kept')
        .addBooleanOption((o) => o.setName('auto').setDescription('Run the cleanup automatically every day'))
        .addIntegerOption((o) =>
          o.setName('mail-text-days').setDescription('Days to keep the full text of sent mail').setMinValue(1).setMaxValue(365)
        )
        .addIntegerOption((o) =>
          o.setName('mail-history-days').setDescription('Days to keep mail records at all').setMinValue(7).setMaxValue(3650)
        )
        .addIntegerOption((o) =>
          o.setName('known-nations-days').setDescription('Days to remember which nations were already seen').setMinValue(7).setMaxValue(365)
        )
        .addIntegerOption((o) =>
          o
            .setName('stale-recruits-days')
            .setDescription('Remove untouched New/Rejected recruits after this many days (0 = never, otherwise 30+)')
            .setMinValue(0)
            .setMaxValue(3650)
        )
    ),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ You need Administrator permission to use this.', flags: 64 });
    }

    const sub = interaction.options.getSubcommand();

    // ---------- settings ----------
    if (sub === 'settings') {
      const patch = {};
      const auto = interaction.options.getBoolean('auto');
      const bodies = interaction.options.getInteger('mail-text-days');
      const history = interaction.options.getInteger('mail-history-days');
      const known = interaction.options.getInteger('known-nations-days');
      const stale = interaction.options.getInteger('stale-recruits-days');

      if (auto !== null) patch.auto = auto;
      if (bodies !== null) patch.mailBodiesDays = bodies;
      if (history !== null) patch.mailHistoryDays = history;
      if (known !== null) patch.knownNationsDays = known;
      if (stale !== null) {
        if (stale !== 0 && stale < 30) {
          return interaction.reply({
            content: '❌ Stale recruits must be kept at least 30 days (or use 0 to never remove them). Nothing was changed.',
            flags: 64,
          });
        }
        patch.staleRecruitsDays = stale;
      }

      const changed = Object.keys(patch).length > 0;
      const c = changed ? saveConfig(patch) : getConfig();
      return interaction.reply({
        content:
          `${changed ? '✅ **Cleanup settings updated**' : '⚙️ **Cleanup settings**'}\n` +
          `• Automatic daily cleanup: **${c.auto ? 'on' : 'off'}**\n` +
          `• Keep full mail text: **${c.mailBodiesDays} days**\n` +
          `• Keep mail records: **${c.mailHistoryDays} days**\n` +
          `• Remember seen nations: **${c.knownNationsDays} days**\n` +
          `• Remove stale recruits after: **${c.staleRecruitsDays > 0 ? c.staleRecruitsDays + ' days' : 'never'}**\n\n` +
          NEVER_TOUCHED,
        flags: 64,
      });
    }

    // ---------- preview / run ----------
    await interaction.deferReply({ flags: 64 });
    const dryRun = sub === 'preview';

    let r;
    try {
      r = runCleanup({ dryRun });
    } catch (err) {
      console.error('❌ /cleanup failed:', err);
      return interaction.editReply(`❌ Cleanup failed: ${err.message}. Nothing was changed.`);
    }

    if (dryRun) {
      return interaction.editReply(
        `🧹 **Cleanup preview** (nothing deleted)\n` +
          `Data file now: **${mb(r.sizeBefore)}**\n\n` +
          `${describePlan(r)}\n\n` +
          (r.total === 0
            ? '✅ Nothing to clean right now.'
            : `Would free about **${mb(r.estimatedBytes)}**. Use \`/cleanup run\` to do it.`) +
          `\n\n${NEVER_TOUCHED}`
      );
    }

    if (r.total === 0) {
      return interaction.editReply('✅ Nothing to clean right now — all data is within your keep limits.');
    }

    return interaction.editReply(
      `✅ **Cleanup complete**\n` +
        `Data file: **${mb(r.sizeBefore)} → ${mb(r.sizeAfter)}**\n\n` +
        `${describePlan(r)}\n\n` +
        `📨 Lifetime mails sent (unchanged by cleanup): **${n(db.getStats().mailsSent)}**\n` +
        (r.snapshot ? `🛟 Safety copy saved on the server as \`${r.snapshot}\`.\n` : '') +
        `\n${NEVER_TOUCHED}`
    );
  },
};
