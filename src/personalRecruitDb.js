// Per-staff personal recruitment database module.
// Each staff member who registers their API key can have their own:
//   - Private template pool (only used in their own auto-recruit)
//   - Auto-recruit on/off toggle
//   - Schedule setting
//   - Known nation IDs (so they never double-mail the same nation)
//
// Data is stored in bot.json under `personalRecruitProfiles` keyed by
// Discord user ID. Completely separate from the shared alliance system.

const store = require('./store');

function loadData() {
  return store.load();
}

function saveData(data) {
  store.save(data);
}

function getProfile(userId) {
  const data = loadData();
  return data.personalRecruitProfiles?.[userId] || null;
}

function ensureProfile(userId) {
  const data = loadData();
  if (!data.personalRecruitProfiles) data.personalRecruitProfiles = {};
  if (!data.personalRecruitProfiles[userId]) {
    data.personalRecruitProfiles[userId] = {
      userId,
      autoRecruitEnabled: false,
      templates: {},
      knownNationIds: {},
      createdAt: new Date().toISOString(),
    };
    saveData(data);
  }
  return data.personalRecruitProfiles[userId];
}

function getAllProfiles() {
  const data = loadData();
  return Object.values(data.personalRecruitProfiles || {});
}

// ---------- Settings ----------

function setPersonalAutoRecruit(userId, enabled) {
  ensureProfile(userId);
  const data = loadData();
  data.personalRecruitProfiles[userId].autoRecruitEnabled = enabled;
  saveData(data);
}

// ---------- Personal templates ----------

function addPersonalTemplate(userId, { id, subject, body, type }) {
  ensureProfile(userId);
  const data = loadData();
  const profile = data.personalRecruitProfiles[userId];
  if (profile.templates[id]) throw new Error(`You already have a template with ID "${id}".`);
  profile.templates[id] = {
    id, subject, body,
    type: type || 'initial',
    createdAt: new Date().toISOString(),
  };
  saveData(data);
  return profile.templates[id];
}

function getPersonalTemplate(userId, id) {
  const profile = getProfile(userId);
  return profile?.templates?.[id] || null;
}

function getAllPersonalTemplates(userId) {
  const profile = getProfile(userId);
  return Object.values(profile?.templates || {});
}

function getPersonalTemplatesByType(userId, type) {
  return getAllPersonalTemplates(userId).filter((t) => (t.type || 'initial') === type);
}

function getRandomPersonalTemplate(userId, type = 'initial') {
  const pool = getPersonalTemplatesByType(userId, type);
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function updatePersonalTemplate(userId, id, fields) {
  ensureProfile(userId);
  const data = loadData();
  const profile = data.personalRecruitProfiles[userId];
  if (!profile.templates[id]) throw new Error(`Template "${id}" not found.`);
  profile.templates[id] = { ...profile.templates[id], ...fields };
  saveData(data);
  return profile.templates[id];
}

function deletePersonalTemplate(userId, id) {
  const data = loadData();
  const profile = data.personalRecruitProfiles?.[userId];
  if (!profile) return false;
  const existed = Boolean(profile.templates[id]);
  delete profile.templates[id];
  saveData(data);
  return existed;
}

// ---------- Known nation IDs (per-staff dedup) ----------

function isPersonalKnownNation(userId, nationId) {
  const profile = getProfile(userId);
  return Boolean(profile?.knownNationIds?.[String(nationId)]);
}

function markPersonalNationKnown(userId, nationId) {
  ensureProfile(userId);
  const data = loadData();
  data.personalRecruitProfiles[userId].knownNationIds[String(nationId)] = new Date().toISOString();
  saveData(data);
}

// Marks many nations known in ONE disk write (used for skipped/blacklisted nations).
function markPersonalNationsKnown(userId, nationIds) {
  if (!nationIds.length) return;
  ensureProfile(userId);
  const data = loadData();
  const now = new Date().toISOString();
  const known = data.personalRecruitProfiles[userId].knownNationIds;
  for (const id of nationIds) known[String(id)] = now;
  saveData(data);
}

module.exports = {
  getProfile,
  ensureProfile,
  getAllProfiles,
  setPersonalAutoRecruit,
  addPersonalTemplate,
  getPersonalTemplate,
  getAllPersonalTemplates,
  getPersonalTemplatesByType,
  getRandomPersonalTemplate,
  updatePersonalTemplate,
  deletePersonalTemplate,
  isPersonalKnownNation,
  markPersonalNationKnown,
  markPersonalNationsKnown,
};
