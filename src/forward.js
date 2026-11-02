import { createHash } from 'node:crypto';
import { proto, isJidNewsletter } from '@whiskeysockets/baileys';
import { loadState, saveState } from './state.js';
import { makeSender } from './sender.js';
import { allTargets, describeTarget } from './targets.js';

/**
 * Channel forwarding ("news digest").
 *
 * Follow a news channel, and once an hour the messages it published during
 * that hour are copied to the channels you pick. Channels are one-way and
 * there is no "forward" API for them, so a message is read back
 * (`newsletterFetchMessages`) or caught live in `messages.upsert`, then posted
 * again as ordinary text.
 *
 * Media is not re-uploaded: a picture-only post is skipped, and a picture with
 * a caption is posted as its caption. That keeps the feature fast and avoids
 * downloading/uploading megabytes every hour on a phone.
 */

const MAX_SEEN = 400;
const MAX_BUFFER = 400;
const MAX_AGE_MINUTES = 180;
const MESSAGE_MAX = 3500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Messages caught live since the app started. */
let live = [];
let running = false;
let lastRun = null;

// ---------------------------------------------------------------- messages

function timestampMs(message) {
  const t = message?.messageTimestamp;
  const n = typeof t === 'number' ? t : Number(t?.toNumber?.() ?? t ?? 0);
  return n > 0 ? (n < 1e12 ? n * 1000 : n) : Date.now();
}

function messageText(message) {
  if (!message) return '';
  return message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || message.documentMessage?.caption
    || '';
}

function hasMedia(message) {
  return Boolean(
    message?.imageMessage
    || message?.videoMessage
    || message?.documentMessage
    || message?.audioMessage
    || message?.stickerMessage,
  );
}

function messageId(message, at, text) {
  return message?.key?.id
    ?? createHash('sha1').update(`${at}|${text}`).digest('hex');
}

/** Channel messages arrive on `messages.upsert`; keep the ones we may forward. */
export function noteIncomingMessage(message) {
  const jid = message?.key?.remoteJid;
  if (!isJidNewsletter(jid) || message.key.fromMe) return;

  const text = messageText(message.message);
  const media = hasMedia(message.message);
  if (!text && !media) return;

  const at = timestampMs(message);
  const id = messageId(message, at, text);
  if (live.some((m) => m.id === id)) return;

  live.push({ jid, id, at, text, media });
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  live = live.filter((m) => m.at >= cutoff).slice(-MAX_BUFFER);
}

export function clearLiveBuffer() {
  live = [];
}

/**
 * The `message_updates` IQ answered by WhatsApp contains `<message>` nodes whose
 * `<plaintext>` child is an encoded proto.Message — the same shape as the live
 * newsletter notification, so one walker handles both.
 */
export function parseMessageUpdates(node) {
  const out = [];
  const seen = new Set();

  const walk = (current) => {
    if (!current || typeof current !== 'object') return;

    if (current.tag === 'message') {
      const attrs = current.attrs ?? {};
      const id = attrs.message_id ?? attrs.server_id ?? null;
      const at = Number(attrs.t ?? 0) * 1000;
      const plain = Array.isArray(current.content)
        ? current.content.find((c) => c?.tag === 'plaintext')
        : null;

      if (plain?.content != null) {
        try {
          const buf = Buffer.isBuffer(plain.content)
            ? plain.content
            : Buffer.from(plain.content);
          const message = proto.Message.decode(buf);
          const text = messageText(message);
          const media = hasMedia(message);
          if (text || media) {
            const key = id ?? createHash('sha1').update(`${at}|${text}`).digest('hex');
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ id: key, at: at || Date.now(), text, media });
            }
          }
        } catch {
          // Not a readable message (a reaction, an edit, encrypted payload) — skip.
        }
      }
    }

    if (Array.isArray(current.content)) {
      for (const child of current.content) walk(child);
    }
  };

  walk(node);
  return out;
}

/** Everything published by one source since `sinceMs`, oldest first. */
async function collectWindow(sock, jid, sinceMs, max) {
  const fromLive = live.filter((m) => m.jid === jid && m.at >= sinceMs);
  let fetched = [];
  let fetchOk = false;

  if (sock?.newsletterFetchMessages) {
    try {
      const node = await sock.newsletterFetchMessages(
        jid,
        Math.min(100, Math.max(1, max)),
        Math.floor(sinceMs / 1000),
        0,
      );
      fetched = parseMessageUpdates(node);
      fetchOk = true;
    } catch {
      // Older WhatsApp builds do not answer this IQ. Live messages still work.
      fetchOk = false;
    }
  }

  const byId = new Map();
  for (const message of [...fetched, ...fromLive]) {
    if (!message.at || message.at < sinceMs) continue;
    byId.set(message.id, message);
  }

  return {
    messages: [...byId.values()].sort((a, b) => a.at - b.at),
    fetchOk: fetchOk || fromLive.length > 0,
  };
}

// ---------------------------------------------------------------- filters

function matches(text, words) {
  const lower = String(text).toLowerCase();
  return words.some((w) => lower.includes(w));
}

/** Keyword allow/block lists. Empty allow list = everything. */
export function filterMessages(messages, forwarder) {
  const allow = (forwarder.keywords ?? []).map((w) => String(w).toLowerCase()).filter(Boolean);
  const block = (forwarder.blocked ?? []).map((w) => String(w).toLowerCase()).filter(Boolean);

  return messages.filter((m) => {
    const text = m.text || '';
    if (block.length && matches(text, block)) return false;
    if (allow.length && !matches(text, allow)) return false;
    return true;
  });
}

function clip(text) {
  const value = String(text ?? '').trim();
  return value.length <= MESSAGE_MAX ? value : `${value.slice(0, MESSAGE_MAX - 1).trimEnd()}…`;
}

function headerFor(source, count, fromMs, toMs) {
  const name = source.name || source.jid;
  const time = new Date(toMs).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  return `📰 *${name}* — ${count} update${count === 1 ? '' : 's'} (till ${time})`;
}

// ---------------------------------------------------------------- state

function forwardState(state) {
  if (!state.forward || typeof state.forward !== 'object') state.forward = { sources: {} };
  if (!state.forward.sources || typeof state.forward.sources !== 'object') state.forward.sources = {};
  return state.forward;
}

/**
 * De-duplication is per destination: if WhatsApp accepted the digest but
 * Telegram failed, only Telegram retries next time.
 */
function targetSeen(entry, key) {
  if (!entry.targets || typeof entry.targets !== 'object') entry.targets = {};
  if (!entry.targets[key]) entry.targets[key] = { seen: [] };
  return entry.targets[key];
}

function rememberSent(entry, id, at) {
  entry.seen = Array.isArray(entry.seen) ? entry.seen : [];
  entry.seen.push({ id, at });
  if (entry.seen.length > MAX_SEEN) entry.seen = entry.seen.slice(-MAX_SEEN);
}

function alreadySeen(entry, id) {
  return Array.isArray(entry.seen) && entry.seen.some((s) => s?.id === id);
}

// ---------------------------------------------------------------- run

/**
 * Forward news to every chosen destination.
 *
 * @param dryRun     true = build the digest and return it without sending
 * @param sourceJid  only this source (used by the "Forward now" button)
 * @param ignoreWindow true = in preview mode, don't restrict to past 60m if empty
 */
export async function forwardWindow({
  cfg,
  getSock,
  ensureConnected,
  log = () => {},
  dryRun = false,
  now = Date.now(),
  sourceJid = null,
  ignoreWindow = false,
}) {
  if (running) throw new Error('A forward run is already in progress.');
  const forwarder = cfg.forwarder ?? {};
  const sources = (forwarder.sources ?? [])
    .filter((s) => s.enabled !== false && (!sourceJid || s.jid === sourceJid));
  if (!sources.length) throw new Error('No source channel set up — add the news channel first.');

  const wanted = new Set(forwarder.targets ?? []);
  const targets = allTargets(cfg).filter((t) => wanted.has(t.key));
  if (!targets.length) throw new Error('Pick at least one channel to forward the news to.');

  const intervalMs = Math.max(1, Number(forwarder.intervalMinutes ?? 60)) * 60000;
  const max = Math.max(1, Number(forwarder.maxPerRun ?? 20));
  const gapMs = Math.max(0, Number(forwarder.gapSeconds ?? 3)) * 1000;
  const maySend = dryRun || !(forwarder.dryRun ?? cfg.dryRun);

  const state = loadState(cfg.channels[0]?.jid ?? '');
  const forward = forwardState(state);

  running = true;
  const report = { at: now, dryRun, sources: [], sent: 0, skipped: 0, errors: [] };

  try {
    for (const source of sources) {
      const entry = forward.sources[source.jid] ?? (forward.sources[source.jid] = {});
      let since = Number(entry.lastAt) || (now - intervalMs);
      if (now - since > MAX_AGE_MINUTES * 60000) since = now - intervalMs;

      // In manual preview, query back further (up to 24h) if normal window has nothing
      if (dryRun && ignoreWindow) {
        since = now - 24 * 60 * 60 * 1000;
      }

      const sock = getSock?.() ?? null;
      let { messages, fetchOk } = await collectWindow(sock, source.jid, since, max * 2);

      // If dry run preview found 0 messages with strict timestamp, retry fetching latest 20 without time barrier
      if (dryRun && messages.length === 0 && sock?.newsletterFetchMessages) {
        try {
          const fallbackNode = await sock.newsletterFetchMessages(source.jid, Math.min(25, max), undefined, 0);
          const fallbackMessages = parseMessageUpdates(fallbackNode);
          if (fallbackMessages.length > 0) {
            messages = fallbackMessages;
            fetchOk = true;
          }
        } catch { /* ignore fallback errors */ }
      }

      let fresh = messages.filter((m) => m.text && m.text.trim());

      const beforeFilter = fresh.length;
      fresh = filterMessages(fresh, forwarder).slice(0, max);
      const filteredOut = beforeFilter - fresh.length;

      const pendingFor = (target) => {
        const seen = targetSeen(entry, target.key);
        return fresh.filter((m) => !alreadySeen(seen, m.id));
      };

      const anyPending = dryRun
        ? fresh.length > 0
        : targets.some((target) => pendingFor(target).length > 0);

      if (!anyPending) {
        if (fetchOk || dryRun) entry.lastAt = now;
        report.sources.push({ jid: source.jid, name: source.name, count: 0, filteredOut });
        continue;
      }

      if (dryRun) {
        report.sources.push({
          jid: source.jid,
          name: source.name,
          count: fresh.length,
          filteredOut,
          messages: fresh.map((m) => clip(m.text)),
        });
        continue;
      }

      const errorsBefore = report.errors.length;

      for (const target of targets) {
        const seen = targetSeen(entry, target.key);
        const toSend = fresh.filter((m) => !alreadySeen(seen, m.id));
        if (!toSend.length) continue;

        const send = makeSender({
          cfg,
          target,
          getSock,
          ensureConnected,
          log: (level, text) => log(level, `[forward] ${text}`),
        });
        try {
          if (forwarder.header !== false) {
            await send({ text: headerFor(source, toSend.length, since, now) }, { phase: 'question' });
          }
          for (const [i, message] of toSend.entries()) {
            await send({ text: clip(message.text) }, { phase: 'question' });
            report.sent += 1;
            if (i < toSend.length - 1 && gapMs) await sleep(gapMs);
          }
          for (const message of toSend) rememberSent(seen, message.id, message.at);
        } catch (err) {
          report.errors.push(`${describeTarget(target)}: ${err.message}`);
          log('err', `Forward to ${describeTarget(target)} failed: ${err.message}`);
        }
      }

      if (report.errors.length === errorsBefore) entry.lastAt = now;
      else entry.lastAt = Math.min(now, entry.lastAt || since);
      entry.lastCount = fresh.length;
      report.sources.push({ jid: source.jid, name: source.name, count: fresh.length, filteredOut });
    }

    if (!dryRun) saveState(state);
  } finally {
    running = false;
    lastRun = report;
  }

  return report;
}

export function forwardStatus(cfg) {
  const forwarder = cfg.forwarder ?? {};
  const state = loadState(cfg.channels[0]?.jid ?? '');
  const saved = state.forward?.sources ?? {};
  const targets = new Set(forwarder.targets ?? []);

  return {
    enabled: forwarder.enabled === true,
    intervalMinutes: forwarder.intervalMinutes ?? 60,
    maxPerRun: forwarder.maxPerRun ?? 20,
    gapSeconds: forwarder.gapSeconds ?? 3,
    header: forwarder.header !== false,
    dryRun: forwarder.dryRun === true,
    keywords: forwarder.keywords ?? [],
    blocked: forwarder.blocked ?? [],
    sources: (forwarder.sources ?? []).map((s) => ({
      ...s,
      lastAt: saved[s.jid]?.lastAt ?? null,
      lastCount: saved[s.jid]?.lastCount ?? null,
    })),
    targetKeys: [...targets],
    liveMessages: live.length,
    lastRun,
  };
}

/** Follow every source and ask for live updates, best effort. */
export async function subscribeSources(sock, cfg) {
  const sources = (cfg.forwarder?.sources ?? []).filter((s) => s.enabled !== false);
  for (const source of sources) {
    try {
      if (typeof sock.newsletterFollow === 'function') await sock.newsletterFollow(source.jid);
    } catch { /* already followed, or the channel needs an invite */ }
    try {
      if (typeof sock.subscribeNewsletterUpdates === 'function') {
        await sock.subscribeNewsletterUpdates(source.jid);
      }
    } catch { /* live updates are a bonus; the hourly fetch still runs */ }
  }
}
