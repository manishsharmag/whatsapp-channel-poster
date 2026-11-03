import { randomUUID } from 'node:crypto';

/**
 * Group growth: find public WhatsApp groups, join them slowly, and share the
 * channel link once per group.
 *
 * This is deliberately conservative. WhatsApp treats automated joining and
 * unsolicited link-dropping as spam, so every action is capped, spaced out and
 * off by default. `dryRun` logs what would happen without touching WhatsApp.
 */

export const GROWTH_DEFAULTS = {
  enabled: false, // master switch for the background worker
  dryRun: true, // start safe: log actions, send nothing
  channelLink: '',
  message: '👋 Daily HSSC / HSSC Group D quiz with answers (English + Hindi).\nJoin the channel: {link}',
  joinPerDay: 3,
  joinGapMinutes: 60,
  shareAfterHours: 24,
  sharePerDay: 2,
  shareGapMinutes: 30,
  maxGroups: 25,
  autoJoin: false,
  autoShare: false,
  allowlist: [],
  blocked: [],
};

/** Accept a full invite link, `chat.whatsapp.com/…`, or a bare code. */
export function inviteCode(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const match = raw.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,})/i);
  if (match) return match[1];
  if (/^[A-Za-z0-9]{10,}$/.test(raw)) return raw;
  return '';
}

export function inviteLink(code) {
  return code ? `https://chat.whatsapp.com/${code}` : '';
}

export function blankGrowth() {
  return {
    day: '',
    joinsToday: 0,
    sharesToday: 0,
    lastJoinAt: 0,
    lastShareAt: 0,
    candidates: [],
    lastSearch: null,
  };
}

/** Create the growth block on first use and repair an older/partial one. */
export function ensureGrowth(state) {
  if (!state.growth || typeof state.growth !== 'object') state.growth = blankGrowth();
  const growth = state.growth;
  if (!Array.isArray(growth.candidates)) growth.candidates = [];
  if (!growth.day) growth.day = '';
  for (const key of ['joinsToday', 'sharesToday', 'lastJoinAt', 'lastShareAt']) {
    const value = Number(growth[key]);
    growth[key] = Number.isFinite(value) ? value : 0;
  }
  if (!growth.lastSearch || typeof growth.lastSearch !== 'object') growth.lastSearch = null;
  return growth;
}

/** Reset the daily counters when the local date changes. */
export function rollGrowthDay(growth, day) {
  if (growth.day !== day) {
    growth.day = day;
    growth.joinsToday = 0;
    growth.sharesToday = 0;
  }
  return growth;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.floor(Number(value) || 0)));
}

export function normalizeGrowthSettings(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const message = String(raw.message ?? GROWTH_DEFAULTS.message).trim();
  return {
    ...GROWTH_DEFAULTS,
    ...raw,
    enabled: raw.enabled === true,
    dryRun: raw.dryRun !== false,
    channelLink: String(raw.channelLink ?? '').trim(),
    message: message || GROWTH_DEFAULTS.message,
    joinPerDay: clamp(raw.joinPerDay ?? GROWTH_DEFAULTS.joinPerDay, 0, 10),
    joinGapMinutes: clamp(raw.joinGapMinutes ?? GROWTH_DEFAULTS.joinGapMinutes, 5, 1440),
    shareAfterHours: clamp(raw.shareAfterHours ?? GROWTH_DEFAULTS.shareAfterHours, 1, 168),
    sharePerDay: clamp(raw.sharePerDay ?? GROWTH_DEFAULTS.sharePerDay, 0, 10),
    shareGapMinutes: clamp(raw.shareGapMinutes ?? GROWTH_DEFAULTS.shareGapMinutes, 1, 1440),
    maxGroups: clamp(raw.maxGroups ?? GROWTH_DEFAULTS.maxGroups, 1, 100),
    autoJoin: raw.autoJoin === true,
    autoShare: raw.autoShare === true,
    allowlist: (Array.isArray(raw.allowlist) ? raw.allowlist : [])
      .map((value) => String(value).trim()).filter(Boolean),
    blocked: (Array.isArray(raw.blocked) ? raw.blocked : [])
      .map((value) => String(value).trim().toLowerCase()).filter(Boolean),
  };
}

/** How many people are actually in the group when the invite was read. */
export function groupSize(info) {
  const size = Number(info?.size);
  if (Number.isFinite(size) && size > 0) return size;
  return Array.isArray(info?.participants) ? info.participants.length : 0;
}

/** True when the group's name/description matches a blocked word. */
export function isBlocked(settings, ...texts) {
  if (!settings.blocked?.length) return false;
  const haystack = texts.filter(Boolean).join(' ').toLowerCase();
  return settings.blocked.some((word) => haystack.includes(word));
}

/** With an allowlist set, only those codes / links / jids may be joined. */
export function isAllowed(settings, { code = '', jid = '', link = '' } = {}) {
  if (!settings.allowlist?.length) return true;
  return settings.allowlist.some((entry) => {
    const clean = String(entry).trim();
    return clean === code || clean === jid || clean === link
      || inviteCode(clean) === code;
  });
}

export function joinedGroups(growth) {
  return (growth.candidates ?? []).filter(
    (c) => c.status !== 'failed' && c.status !== 'left' && c.joinedAt,
  );
}

export function pendingCandidates(growth) {
  return (growth.candidates ?? []).filter((c) => !c.joinedAt && c.status !== 'failed');
}

/**
 * Can we join one more group right now?
 * Returns `{ ok, reason, waitMs }` so the panel can explain the wait.
 */
export function joinGate(growth, settings, now = Date.now()) {
  if (!settings.enabled) return { ok: false, reason: 'Growth is off.' };
  if (!settings.channelLink) {
    return { ok: false, reason: 'Add your channel link first (Channels tab).' };
  }
  if (joinedGroups(growth).length >= settings.maxGroups) {
    return { ok: false, reason: `Group limit reached (${settings.maxGroups}).` };
  }
  if (growth.joinsToday >= settings.joinPerDay) {
    return { ok: false, reason: `Daily join limit reached (${settings.joinPerDay}).` };
  }
  const waitMs = growth.lastJoinAt
    ? settings.joinGapMinutes * 60_000 - (now - growth.lastJoinAt)
    : 0;
  if (waitMs > 0) {
    return { ok: false, waitMs, reason: `Next join in ${Math.ceil(waitMs / 60_000)} min.` };
  }
  return { ok: true };
}

/** The oldest group that is old enough to receive the channel link. */
export function nextShare(growth, settings, now = Date.now()) {
  if (!settings.enabled) return { ok: false, reason: 'Growth is off.' };
  if (!settings.channelLink) return { ok: false, reason: 'Add your channel link first.' };
  if (growth.sharesToday >= settings.sharePerDay) {
    return { ok: false, reason: `Daily share limit reached (${settings.sharePerDay}).` };
  }
  const waitMs = growth.lastShareAt
    ? settings.shareGapMinutes * 60_000 - (now - growth.lastShareAt)
    : 0;
  if (waitMs > 0) {
    return { ok: false, waitMs, reason: `Next share in ${Math.ceil(waitMs / 60_000)} min.` };
  }
  const due = joinedGroups(growth)
    .filter((c) => !c.sharedAt)
    .filter((c) => !(c.dryShareAt && now - c.dryShareAt < 12 * 3_600_000))
    .filter((c) => now - c.joinedAt >= settings.shareAfterHours * 3_600_000)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  if (!due.length) {
    return { ok: false, reason: `Nothing is due yet (wait ${settings.shareAfterHours}h after joining).` };
  }
  return { ok: true, candidate: due[0] };
}

/** Fill `{link}` / `{name}` in the configured share message. */
export function shareText(settings, candidate = {}) {
  return String(settings.message || GROWTH_DEFAULTS.message)
    .replaceAll('{link}', settings.channelLink || '')
    .replaceAll('{name}', candidate.subject || 'the channel');
}

/** Build a candidate row from a previewed invite. */
export function makeCandidate({ code, jid = '', subject = '', size = 0, status = 'pending' }) {
  return {
    id: randomUUID(),
    code,
    jid: jid || '',
    subject: subject || `Group ${code.slice(0, 6)}…`,
    size: Number(size) || 0,
    status,
    addedAt: Date.now(),
    joinedAt: 0,
    sharedAt: 0,
    dryJoinAt: 0,
    dryShareAt: 0,
    error: '',
  };
}

/** A short label for a candidate/group. */
export function candidateLabel(candidate) {
  return candidate.subject || (candidate.jid ? candidate.jid.replace(/@.*$/, '') : candidate.code);
}
