import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROWTH_DEFAULTS, normalizeGrowthSettings } from './growth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Auto-load .env file if present so EXA_API_KEY and PANEL_PASSWORD are easy to manage locally. */
function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key] && val) process.env[key] = val;
      }
    }
  } catch {}
}
loadEnvFile();

/**
 * Where mutable files live: config.json, state/ and auth/.
 *
 * On a cloud host the app bundle is replaced on every deploy; DATA_DIR should
 * point at a mounted volume so the WhatsApp session and posting progress are
 * not wiped. Locally it defaults to the project folder (old behaviour).
 */
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;

export function projectRoot() {
  return ROOT;
}

export function dataDir() {
  return DATA_DIR;
}

export function configFile() {
  return path.join(DATA_DIR, 'config.json');
}

/**
 * A usable channel ID looks like "120363012345678901@newsletter".
 * Catches the config placeholder, invite links and normal chats.
 */
export function isValidChannelJid(jid) {
  return typeof jid === 'string' && /^\d{10,}@newsletter$/.test(jid.trim());
}

export function channelJidError(jid) {
  const value = (jid ?? '').trim();
  if (!value || value.includes('PUT_YOUR')) {
    return 'Your channel ID is not set. Paste your channel invite link and click "Find ID from link".';
  }
  if (value.startsWith('http')) {
    return 'That is an invite link, not a channel ID. Click "Find ID from link" to convert it.';
  }
  if (!value.endsWith('@newsletter')) {
    return 'That is not a channel ID — it must end with "@newsletter".';
  }
  return 'Channel ID looks invalid. It should be digits followed by "@newsletter".';
}

const DEFAULTS = {
  // Kept for compatibility: it mirrors channels[0]. "channels" is the real list.
  channelJid: '',
  // Channels to post to: [{ jid, name, enabled }]
  channels: [],
  // Telegram: { enabled, botToken, chats: [{ chatId, name, enabled }] }
  telegram: { enabled: false, botToken: '', chats: [] },
  // Which questions a run may use. Empty lists = everything.
  selection: { modules: [], subtopics: [], mode: 'sequence' },
  bankPaths: [],
  timezone: 'Asia/Kolkata',
  mode: 'quiz', // "quiz" = question at postTimes[0], answer at postTimes[1] | "single" = question + answer in one post
  postTimes: ['08:00', '20:00'],
  language: 'both', // "en" | "hi" | "both"
  rotateModules: true,
  shuffleOptions: true,
  showModuleTag: true,
  showQuestionNumber: true,
  showSubtopic: false,
  showExplanation: true,
  headerEmoji: '📘',
  answerEmoji: '✅',
  replyPrompt: 'Reply with your answer 👇',
  hashtags: [],
  dryRun: true,
  loginMethod: 'qr', // "qr" | "pairing"
  phoneNumber: '',
  resetWhenFinished: false,
  // Skip questions whose options were mangled by PDF extraction (e.g. two
  // options that read the same). They cannot be answered and look broken.
  skipDuplicateOptions: true,

  // Used by the `batch` command (the desktop click-to-run poster).
  batch: {
    size: 50,
    gapSeconds: 20,
    includeAnswer: false,
    introMessage: true,
    // "quiz"  = WhatsApp quiz: tap-to-answer with right/wrong feedback
    // "poll"  = plain poll: tap-to-answer, no correct answer
    // "text"  = plain text with A) B) C) D)
    style: 'quiz',
    scorePrompt: "❓ *What's your score?* Reply with how many you got right 👇",
    // Finish the batch with a score poll instead of a plain text summary.
    // A channel has no replies, so a text "what's your score?" gets nothing
    // back; a poll gives subscribers a tap-to-respond button.
    scorePoll: true,
    scorePollPrompt: "❓ *What's your score?* Tap the band you got 👇",
    // Optional custom bands. Leave empty to scale them to batch.size
    // (50 -> "50/50 🏆, 40–49, 30–39, 20–29, 10–19, Below 10").
    scoreBands: [],
  },

  // Copy a news channel's messages to your channel(s), once per interval.
  forwarder: {
    enabled: false,
    intervalMinutes: 60,
    sources: [], // [{ jid, name, enabled }] — channels to read
    targets: [], // ["wa:<channel jid>", "tg:<chat id>"] — where to post
    maxPerRun: 20,
    gapSeconds: 3,
    header: true,
    dryRun: false,
    keywords: [],
    blocked: [],
  },

  // Automatic run(s) at fixed local times — the daily quiz without clicking.
  schedule: {
    enabled: false,
    times: ['08:00'], // local wall-clock times, "HH:MM"
    weekdays: [], // [] = every day; 0 = Sunday … 6 = Saturday
    size: 0, // 0 = use batch.size
    gapSeconds: -1, // -1 = use batch.gapSeconds
    style: '', // '' = use batch.style
  },

  // Group growth: join public groups slowly and share the channel link once.
  // Off by default, dry-run by default — this is the part that gets numbers
  // banned when it is rushed.
  growth: GROWTH_DEFAULTS,
};

export function loadConfig() {
  const file = configFile();
  const exampleFile = path.join(ROOT, 'config.example.json');
  const bundled = path.join(ROOT, 'config.json');

  if (!fs.existsSync(file)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (DATA_DIR !== ROOT && fs.existsSync(bundled)) {
      // Keep the settings that were deployed with the app (channels, banks),
      // then let the user edit them in the persistent volume.
      console.log(`ℹ️  Seeding ${file} from the bundled config.json`);
      fs.copyFileSync(bundled, file);
    } else if (fs.existsSync(exampleFile)) {
      console.log('ℹ️  config.json not found — creating default config.json from config.example.json');
      fs.copyFileSync(exampleFile, file);
    } else {
      throw new Error(`config.json not found at ${file}`);
    }
  }

  const user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const cfg = { ...DEFAULTS, ...user };

  const paths = cfg.bankPaths?.length ? cfg.bankPaths : cfg.bankPath ? [cfg.bankPath] : [];
  if (!paths.length) throw new Error('Set "bankPaths" (array of JSON files) in config.json');
  // Relative paths ("banks/volume1.json") are resolved from the project folder,
  // not from whatever directory the panel happened to be launched in.
  cfg.bankPaths = paths.map((p) => path.resolve(ROOT, p));
  for (const p of cfg.bankPaths) {
    if (!fs.existsSync(p)) throw new Error(`bank file does not exist: ${p}`);
  }

  if (process.env.DRY_RUN === 'true') cfg.dryRun = true;
  if (process.env.DRY_RUN === 'false') cfg.dryRun = false;

  if (!['quiz', 'single'].includes(cfg.mode)) throw new Error('mode must be "quiz" or "single"');
  if (!['en', 'hi', 'both'].includes(cfg.language)) throw new Error('language must be "en", "hi" or "both"');
  if (!Array.isArray(cfg.postTimes) || cfg.postTimes.length === 0) throw new Error('postTimes must be a non-empty array');

  // ---- posting targets -------------------------------------------------
  // "channels" is the source of truth; an older config.json with just
  // "channelJid" is folded into it so nothing breaks.
  const channels = (Array.isArray(user.channels) ? user.channels : [])
    .map((c) => (typeof c === 'string' ? { jid: c } : c ?? {}))
    .map((c) => ({
      jid: String(c.jid ?? '').trim(),
      name: String(c.name ?? '').trim(),
      enabled: c.enabled !== false,
    }))
    .filter((c) => isValidChannelJid(c.jid));
  const legacyJid = String(cfg.channelJid ?? '').trim();
  if (!channels.length && isValidChannelJid(legacyJid)) {
    channels.push({ jid: legacyJid, name: '', enabled: true });
  }
  // De-duplicate: the same channel pasted twice must not post twice.
  const seenJids = new Set();
  cfg.channels = channels.filter((c) => (seenJids.has(c.jid) ? false : seenJids.add(c.jid)));
  cfg.channelJid = cfg.channels[0]?.jid ?? legacyJid;

  const tg = user.telegram ?? {};
  const tgChats = (Array.isArray(tg.chats) ? tg.chats : [])
    .map((c) => (typeof c === 'string' ? { chatId: c } : c ?? {}))
    .map((c) => ({
      chatId: String(c.chatId ?? '').trim(),
      name: String(c.name ?? '').trim(),
      enabled: c.enabled !== false,
    }))
    .filter((c) => c.chatId);
  const seenChats = new Set();
  cfg.telegram = {
    enabled: tg.enabled === true,
    // Tokens are pasted by hand: drop any stray space or line break, otherwise
    // the request URL is wrong and Telegram answers "Not Found".
    botToken: String(tg.botToken ?? '').replace(/\s+/g, ''),
    chats: tgChats.filter((c) => (seenChats.has(c.chatId) ? false : seenChats.add(c.chatId))),
  };

  const sel = user.selection ?? {};

  // A "mix" is a per-subject quota: 10 Quantitative Ability + 10 Reasoning + …
  // Duplicate modules are summed so the same subject cannot be listed twice.
  const quotaCounts = new Map();
  for (const item of Array.isArray(sel.quotas) ? sel.quotas : []) {
    const module = String(item?.module ?? '').trim();
    const count = Math.floor(Number(item?.count) || 0);
    if (!module || count < 1) continue;
    quotaCounts.set(module, Math.min(1000, (quotaCounts.get(module) ?? 0) + count));
  }

  cfg.selection = {
    modules: (Array.isArray(sel.modules) ? sel.modules : []).map((m) => String(m)).filter(Boolean),
    subtopics: (Array.isArray(sel.subtopics) ? sel.subtopics : []).map((s) => String(s)).filter(Boolean),
    mode: sel.mode === 'random' ? 'random' : 'sequence',
    quotas: [...quotaCounts].map(([module, count]) => ({ module, count })),
    quotaOrder: sel.quotaOrder === 'mixed' ? 'mixed' : 'grouped',
  };

  cfg.batch = { ...DEFAULTS.batch, ...(user.batch ?? {}) };
  if (cfg.batch.size < 1) throw new Error('batch.size must be at least 1');
  if (cfg.batch.gapSeconds < 0) throw new Error('batch.gapSeconds cannot be negative');
  if (!['quiz', 'poll', 'text'].includes(cfg.batch.style)) cfg.batch.style = 'text';
  cfg.batch.scoreBands = (Array.isArray(cfg.batch.scoreBands) ? cfg.batch.scoreBands : [])
    .map((band) => String(band).trim())
    .filter(Boolean);
  if (cfg.batch.scoreBands.length > 12) {
    throw new Error('batch.scoreBands can hold at most 12 options (WhatsApp limit)');
  }

  // ---- news forwarder --------------------------------------------------
  const fw = user.forwarder ?? {};
  const fwSources = (Array.isArray(fw.sources) ? fw.sources : [])
    .map((s) => (typeof s === 'string' ? { jid: s } : s ?? {}))
    .map((s) => ({
      jid: String(s.jid ?? '').trim(),
      name: String(s.name ?? '').trim(),
      enabled: s.enabled !== false,
    }))
    .filter((s) => isValidChannelJid(s.jid));
  const seenSources = new Set();
  cfg.forwarder = {
    ...DEFAULTS.forwarder,
    ...fw,
    sources: fwSources.filter((s) => (seenSources.has(s.jid) ? false : seenSources.add(s.jid))),
    targets: (Array.isArray(fw.targets) ? fw.targets : []).map((t) => String(t)).filter(Boolean),
    keywords: (Array.isArray(fw.keywords) ? fw.keywords : []).map((w) => String(w).trim()).filter(Boolean),
    blocked: (Array.isArray(fw.blocked) ? fw.blocked : []).map((w) => String(w).trim()).filter(Boolean),
  };
  cfg.forwarder.intervalMinutes = Math.max(5, Number(cfg.forwarder.intervalMinutes) || 60);
  cfg.forwarder.maxPerRun = Math.max(1, Math.min(100, Number(cfg.forwarder.maxPerRun) || 20));
  cfg.forwarder.gapSeconds = Math.max(0, Number(cfg.forwarder.gapSeconds) || 0);
  cfg.forwarder.enabled = fw.enabled === true;
  cfg.forwarder.header = fw.header !== false;
  cfg.forwarder.dryRun = fw.dryRun === true;

  // ---- daily schedule --------------------------------------------------
  const sch = user.schedule ?? {};
  const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t ?? '').trim());
  const times = (Array.isArray(sch.times) ? sch.times : [sch.times])
    .map((t) => String(t ?? '').trim())
    .filter(validTime)
    .sort();
  cfg.schedule = {
    ...DEFAULTS.schedule,
    ...sch,
    times: times.length ? [...new Set(times)] : DEFAULTS.schedule.times,
    weekdays: (Array.isArray(sch.weekdays) ? sch.weekdays : [])
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
  };
  cfg.schedule.enabled = sch.enabled === true && cfg.schedule.times.length > 0;
  cfg.schedule.size = Math.max(0, Number(cfg.schedule.size) || 0);
  cfg.schedule.gapSeconds = Number.isFinite(Number(cfg.schedule.gapSeconds))
    ? Number(cfg.schedule.gapSeconds)
    : -1;
  if (!['quiz', 'poll', 'text'].includes(cfg.schedule.style)) cfg.schedule.style = '';

  // ---- group growth ----------------------------------------------------
  cfg.growth = normalizeGrowthSettings(user.growth);
  if (cfg.growth.enabled && !cfg.growth.channelLink) {
    console.warn('⚠️  growth.enabled is on but growth.channelLink is empty — growth will wait.');
  }

  if (cfg.mode === 'quiz' && cfg.postTimes.length < 2) {
    console.warn('⚠️  mode "quiz" needs two postTimes (question + answer). Falling back to "single".');
    cfg.mode = 'single';
  }

  return cfg;
}
