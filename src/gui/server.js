import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { loadConfig } from '../config.js';
import { loadState, saveState, targetState, recordRun } from '../state.js';
import { connectWhatsApp } from '../whatsapp.js';
import { loadPool, previewNext, runBatch, topicInventory, describeContent, buildContents } from '../batch.js';
import { optionOrder } from '../format.js';
import { allTargets, enabledTargets, targetByKey, describeTarget } from '../targets.js';
import { makeSender } from '../sender.js';
import { telegramMe, telegramUpdates, telegramChatInfo, chatsFromUpdates } from '../telegram.js';
import { acquireLock } from '../lock.js';
import { writeFileAtomic } from '../fsutil.js';
import { nextScheduleAt, dueSlot, describeSchedule } from '../schedule.js';
import {
  forwardWindow,
  forwardStatus,
  noteIncomingMessage,
  subscribeSources,
} from '../forward.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const AUTH_DIR = path.join(ROOT, 'auth');
const UI_FILE = path.join(__dirname, 'index.html');

const PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 8777);
const HOST = process.env.HOST ?? '0.0.0.0';

let cfg = loadConfig();

let sock = null;
let connecting = false;
let generation = 0;
let reconnectTimer = null;
let reconnectDelay = 3000;
let status = 'disconnected';
let qrDataUrl = null;
// Pairing code flow: the phone cannot scan a QR shown on its own screen.
let pairingCode = null;
let pairingPhone = null;
let pairingError = null;
let me = null;
let logs = [];
let batchRunning = false;
let stopRequested = false;
const bankCache = new Map();

const sseClients = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers

function log(level, text) {
  for (const line of String(text).split('\n')) {
    const entry = { t: Date.now(), level, text: line };
    logs.push(entry);
    if (logs.length > 400) logs.shift();
    broadcast('log', entry);
    const tag = { ok: 'OK  ', err: 'ERR ', warn: 'WARN', info: 'INFO' }[level] ?? 'INFO';
    console.log(`[${tag}] ${line}`);
  }
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.write(payload);
}

function clearBankCache() {
  bankCache.clear();
}

const NO_FILTER = { modules: [], subtopics: [], mode: 'sequence' };

/**
 * The whole bank, ignoring the topic filter — so a channel's "50/4688 sent"
 * number does not jump around when you pick a different subtopic. The filtered
 * count is the separate "N questions available" line.
 */
function getBank(targetKey = '') {
  if (!bankCache.has(targetKey)) {
    bankCache.set(targetKey, loadPool({ ...cfg, selection: NO_FILTER }, targetKey));
  }
  return bankCache.get(targetKey);
}

function targetStats(targetKey) {
  try {
    const bank = getBank(targetKey);
    const total = bank.queue.length;
    return {
      covered: bank.covered,
      total,
      remaining: Math.max(0, total - bank.covered),
      duplicates: bank.duplicates,
      badOptions: bank.badOptions ?? 0,
    };
  } catch {
    return { covered: 0, total: 0, remaining: 0, duplicates: 0, badOptions: 0 };
  }
}

function readRawConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
}

function publicConfig() {
  return {
    channels: cfg.channels,
    telegram: cfg.telegram,
    selection: cfg.selection,
    language: cfg.language,
    shuffleOptions: cfg.shuffleOptions !== false,
    showExplanation: cfg.showExplanation !== false,
    hashtags: cfg.hashtags ?? [],
    dryRun: cfg.dryRun !== false,
    batch: cfg.batch,
    forwarder: cfg.forwarder,
    schedule: cfg.schedule,
    phoneNumber: cfg.phoneNumber ?? '',
    loginMethod: cfg.loginMethod ?? 'qr',
  };
}

function statusPayload() {
  const targets = allTargets(cfg).map((t) => ({
    key: t.key,
    kind: t.kind,
    label: t.label,
    jid: t.jid ?? null,
    chatId: t.chatId ?? null,
    enabled: t.enabled,
    ...targetStats(t.key),
  }));
  const usable = targets.filter((t) => t.enabled).length;

  return {
    status,
    me,
    qr: qrDataUrl,
    pairingCode,
    pairingPhone,
    pairingError,
    running: batchRunning,
    connecting,
    targets,
    usable,
    channelValid: usable > 0,
    channelError: usable > 0 ? null : 'No channel selected yet — add a WhatsApp channel or a Telegram chat below.',
    forward: forwardStatus(cfg),
    schedule: scheduleStatus(),
    runs: recentRuns(),
    stats: targetStats(enabledTargets(cfg)[0]?.key ?? targets[0]?.key ?? ''),
    config: publicConfig(),
    bankFiles: cfg.bankPaths.map((p) => path.basename(p)),
  };
}

function pushStatus() {
  broadcast('status', statusPayload());
}

function saveConfigPatch(patch) {
  const raw = readRawConfig();
  const next = { ...raw, ...patch };
  if (patch.batch) next.batch = { ...(raw.batch ?? {}), ...patch.batch };
  if (patch.forwarder) next.forwarder = { ...(raw.forwarder ?? {}), ...patch.forwarder };
  if (patch.schedule) next.schedule = { ...(raw.schedule ?? {}), ...patch.schedule };
  if (patch.telegram && raw.telegram) {
    next.telegram = { ...raw.telegram, ...patch.telegram };
    if (patch.telegram.chats) next.telegram.chats = patch.telegram.chats;
  }
  // Keep yesterday's file: if a wrong token or channel is saved, the previous
  // settings are one rename away instead of retyped from memory.
  try {
    if (fs.existsSync(CONFIG_FILE)) fs.copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.bak`);
  } catch { /* a backup must never block saving a setting */ }
  writeFileAtomic(CONFIG_FILE, JSON.stringify(next, null, 2));
  cfg = loadConfig();
  clearBankCache();
  if (patch.forwarder?.enabled !== undefined || patch.forwarder?.intervalMinutes !== undefined) {
    scheduleForwarder();
  }
  if (patch.schedule) armSchedule();
  log('info', 'Settings saved.');
  pushStatus();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------- forwarder

let forwardTimer = null;
let forwardNextAt = 0;

/** Next wall-clock slot, e.g. 15:00 for an hourly digest or every N minutes. */
function nextSlot(now = Date.now()) {
  const minutes = Math.max(1, Number(cfg.forwarder?.intervalMinutes ?? 60));
  const from = new Date(now);
  const next = new Date(from);
  next.setSeconds(0, 0);
  if (minutes >= 60) {
    next.setMinutes(0, 0, 0);
    next.setHours(from.getHours() + Math.max(1, Math.round(minutes / 60)));
  } else {
    next.setMinutes(Math.ceil((from.getMinutes() + 0.01) / minutes) * minutes);
  }
  return next.getTime();
}

function scheduleForwarder() {
  clearInterval(forwardTimer);
  forwardTimer = null;
  if (!cfg.forwarder?.enabled) return;
  forwardNextAt = nextSlot();
  forwardTimer = setInterval(() => {
    if (!cfg.forwarder?.enabled || Date.now() < forwardNextAt) return;
    forwardNextAt = nextSlot();
    runForward({ reason: 'scheduled' }).catch((err) => log('err', `Forwarder: ${err.message}`));
  }, 5000);
  log('info', `News forwarder armed — next digest at ${new Date(forwardNextAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}.`);
}

/** Preview (dryRun) or send the digest for the window that just closed. */
async function runForward({ dryRun = false, sourceJid = null, reason = 'manual', ignoreWindow = false } = {}) {
  const forwarder = cfg.forwarder ?? {};
  if (!forwarder.sources?.length) throw new Error('Add the news channel you want to forward from.');
  if (!forwarder.targets?.length) throw new Error('Pick where the news should be posted.');

  if (!dryRun && forwarder.targets.some((k) => k.startsWith('wa:'))) {
    await ensureConnect();
    await waitForConnection();
  }

  const report = await forwardWindow({
    cfg,
    getSock: () => sock,
    ensureConnected: () => ensureConnect(),
    log,
    dryRun,
    sourceJid,
    ignoreWindow,
  });

  const total = report.sources.reduce((n, s) => n + s.count, 0);
  if (reason === 'scheduled' || reason === 'manual') {
    log(total ? 'ok' : 'info', dryRun
      ? `Forward preview — ${total} message(s) would go out.`
      : `News forwarded — ${total} message(s) from ${report.sources.filter((s) => s.count).length} source(s).`);
  }
  pushStatus();
  return report;
}

async function addForwardSource(link) {
  if (!link) throw new Error('Paste the news channel invite link first.');
  await ensureConnect();
  await waitForConnection();
  const code = String(link).replace(/.*channel\//i, '').replace(/[^0-9A-Za-z]/g, '');
  const meta = await sock.newsletterMetadata('invite', code);
  if (!meta?.id) throw new Error('Could not resolve that link. Is the channel public?');

  const sources = (cfg.forwarder.sources ?? []).map((s) => ({ ...s }));
  if (sources.some((s) => s.jid === meta.id)) throw new Error('That channel is already a source.');

  // Following is what lets the fetch/live feed see its posts.
  try { await sock.newsletterFollow(meta.id); } catch { /* already followed */ }

  sources.push({ jid: meta.id, name: meta.name ?? '', enabled: true });
  saveConfigPatch({ forwarder: { ...cfg.forwarder, sources } });
  log('ok', `News source added: ${meta.name ?? meta.id}`);
  return meta;
}

function removeForwardSource(jid) {
  const sources = (cfg.forwarder.sources ?? []).filter((s) => s.jid !== jid);
  saveConfigPatch({ forwarder: { ...cfg.forwarder, sources } });
  log('warn', `News source removed: ${jid}`);
}

// ---------------------------------------------------------------- schedule

let scheduleTimer = null;
let scheduleNextAt = 0;

function lastSlotRun() {
  try {
    return loadState(cfg.channels[0]?.jid ?? '').schedule?.lastSlot ?? null;
  } catch {
    return null;
  }
}

function rememberSlot(slot) {
  try {
    const state = loadState(cfg.channels[0]?.jid ?? '');
    state.schedule = { ...(state.schedule ?? {}), lastSlot: slot };
    saveState(state);
  } catch { /* next boot will simply skip a slot that already ran */ }
}

/**
 * Check every 20 s rather than sleeping until the exact moment: a phone that
 * was asleep, or a laptop that resumed from hibernation, catches up on the next
 * tick instead of missing the day. The stored slot key stops it firing twice.
 */
function armSchedule() {
  clearInterval(scheduleTimer);
  scheduleTimer = null;
  scheduleNextAt = nextScheduleAt(cfg.schedule);
  if (!cfg.schedule?.enabled) return;

  scheduleTimer = setInterval(() => {
    if (!cfg.schedule?.enabled || batchRunning) return;
    const slot = dueSlot(cfg.schedule);
    if (!slot || lastSlotRun() === slot) return;
    rememberSlot(slot);
    scheduleNextAt = nextScheduleAt(cfg.schedule);
    log('info', `Daily schedule fired for ${slot}.`);
    startBatch({ reason: 'schedule' }).catch((err) => log('err', `Scheduled run: ${err.message}`));
  }, 20000);

  log('info', `Daily schedule armed — ${describeSchedule(cfg.schedule)}.`);
}

function scheduleStatus() {
  return {
    ...(cfg.schedule ?? {}),
    nextAt: nextScheduleAt(cfg.schedule),
  };
}

/** Last few finished runs, newest first. */
function recentRuns(limit = 8) {
  try {
    const state = loadState(cfg.channels[0]?.jid ?? '');
    return (state.runs ?? []).slice(-limit).reverse();
  } catch {
    return [];
  }
}

function recordRunHistory({ targetKey, label, result, reason }) {
  try {
    const state = loadState(cfg.channels[0]?.jid ?? '');
    recordRun(state, {
      targetKey,
      label,
      reason,
      sent: result.sent ?? 0,
      failed: result.failed ?? 0,
      stopped: Boolean(result.stopped),
      finished: Boolean(result.finished),
      covered: result.covered ?? 0,
      total: result.total ?? 0,
      summaryError: result.summaryError ?? null,
      ms: result.ms ?? null,
    });
    saveState(state);
  } catch (err) {
    log('warn', `Could not save the run history: ${err.message}`);
  }
}

// ---------------------------------------------------------------- connection

/**
 * Tears down the current socket completely. Without this, a reconnect could
 * leave two sockets alive at once — they then replace each other forever,
 * which is exactly what "Connection closed (440)" in a loop means.
 */
function destroySocket() {
  const old = sock;
  sock = null;
  if (!old) return;
  try {
    old.ev?.removeAllListeners?.();
  } catch { /* ignore */ }
  try {
    old.end?.(new Error('socket replaced'));
  } catch { /* ignore */ }
  try {
    old.ws?.close?.();
  } catch { /* ignore */ }
}

function scheduleReconnect(reason) {
  clearTimeout(reconnectTimer);
  if (status === 'logged_out') return;
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    ensureConnect().catch((e) => log('err', e.message));
  }, reconnectDelay);
  log('warn', `Reconnecting in ${Math.round(reconnectDelay / 1000)}s — ${reason}`);
}

/**
 * A pairing attempt that was interrupted leaves credentials that are not
 * registered yet. WhatsApp answers those with 401, so drop them before a new
 * attempt instead of showing a permanent "logged out".
 */
function discardUnregisteredAuth() {
  const credsFile = path.join(AUTH_DIR, 'creds.json');
  if (!fs.existsSync(AUTH_DIR)) return false;
  try {
    if (fs.existsSync(credsFile)) {
      const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
      if (creds?.registered && creds?.me?.id) return false;
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    log('warn', 'Discarded an unfinished WhatsApp link before reconnecting.');
    return true;
  } catch {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
    return true;
  }
}

async function ensureConnect({ force = false } = {}) {
  if (force) {
    clearTimeout(reconnectTimer);
    destroySocket();
    generation++;
    pairingCode = null;
    pairingError = null;
  }
  if (sock?.user) return sock;
  if (connecting) return sock;

  // Never reuse a half-finished link: it can only fail with 401.
  discardUnregisteredAuth();

  connecting = true;
  const myGeneration = ++generation;
  status = 'connecting';
  pushStatus();

  try {
    const s = await connectWhatsApp(cfg, {
      printQR: false,
      onQR: async (qr) => {
        if (myGeneration !== generation) return;
        status = 'awaiting_qr';
        try {
          qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        } catch {
          qrDataUrl = null;
        }
        pushStatus();
      },
      onPairingCode: (code, phone, error) => {
        if (myGeneration !== generation) return;
        if (code) {
          pairingCode = code;
          pairingPhone = phone;
          pairingError = null;
          log('ok', `Pairing code for +${phone}: ${code}`);
        } else {
          pairingCode = null;
          pairingError = error ?? 'Could not create a pairing code.';
          log('err', `Pairing code failed: ${pairingError}`);
        }
        pushStatus();
      },
      onOpen: (opened) => {
        if (myGeneration !== generation) return;
        status = 'connected';
        qrDataUrl = null;
        pairingCode = null;
        pairingError = null;
        pairingPhone = null;
        // Use the socket handed to us — the module-level one may not be assigned yet.
        me = opened?.user?.id ?? opened?.authState?.creds?.me?.id ?? null;
        reconnectDelay = 3000;
        clearBankCache();
        // Live channel posts: buffered so the hourly digest can forward them
        // even if the history fetch is not supported.
        try {
          opened?.ev?.on('messages.upsert', ({ messages = [] }) => {
            for (const message of messages) noteIncomingMessage(message);
          });
        } catch { /* socket has no event emitter — fetch still works */ }
        subscribeSources(opened, cfg).catch(() => {});
        log('ok', `Connected to WhatsApp as ${me ?? 'unknown'}`);
        pushStatus();
      },
      onClose: (code, loggedOut) => {
        if (myGeneration !== generation) return;
        const wasLinked = !!me;
        sock = null;
        me = null;
        qrDataUrl = null;
        if (loggedOut) {
          // Never linked here: a pairing attempt was cancelled, or its code
          // expired. That is not a real logout — show how to get a new code.
          if (!wasLinked) {
            status = 'disconnected';
            pairingCode = null;
            pairingPhone = null;
            pairingError = 'WhatsApp closed the link. Click "Get pairing code" for a new code, or "Re-link WhatsApp" to start over.';
            log('warn', pairingError);
            pushStatus();
            return;
          }
          status = 'logged_out';
          pairingCode = null;
          pairingError = null;
          log('err', 'Logged out. Click "Re-link WhatsApp" to scan a fresh QR.');
          pushStatus();
          return;
        }
        status = 'disconnected';
        pushStatus();
        if (code === 440) {
          log('warn', 'Connection replaced by another session. Make sure only ONE window of this app is open.');
        }
        scheduleReconnect(`code ${code ?? '?'}`);
      },
    });

    if (myGeneration !== generation) {
      try { s.end?.(new Error('superseded')); } catch { /* ignore */ }
      return null;
    }
    sock = s;
    return s;
  } finally {
    connecting = false;
  }
}

async function waitForConnection(timeoutMs = 120000) {
  const started = Date.now();
  while (!sock?.user) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Could not connect to WhatsApp. Check the connection panel and scan the QR if shown.');
    }
    await sleep(1000);
  }
}

/** Confirms a target exists AND that we are allowed to post to it. */
async function verifyTarget(target) {
  if (target.kind === 'telegram') {
    const chat = await telegramChatInfo(cfg, target.chatId);
    const name = chat?.title ?? chat?.username ?? target.chatId;
    log('ok', `Telegram target verified: ${name}`);
    return chat;
  }
  const meta = await sock.newsletterMetadata('jid', target.jid);
  if (!meta?.id) throw new Error(`Could not read the channel ${target.jid}. Check the channel ID.`);
  log('ok', `Channel verified: ${meta.name ?? target.jid}`);
  return meta;
}

// ---------------------------------------------------------------- actions

async function startBatch({ reason = 'manual' } = {}) {
  if (batchRunning) throw new Error('A batch is already running.');

  const targets = enabledTargets(cfg);
  if (!targets.length) {
    throw new Error('No channel selected. Tick a WhatsApp channel or a Telegram chat on the right.');
  }

  // A scheduled run may use its own size / gap / style, so the daily quiz can
  // differ from whatever is typed in card 1.
  const sch = cfg.schedule ?? {};
  const scheduled = reason === 'schedule';
  const runCfg = {
    ...cfg,
    batch: {
      ...cfg.batch,
      ...(scheduled && sch.size > 0 ? { size: sch.size } : {}),
      ...(scheduled && sch.gapSeconds >= 0 ? { gapSeconds: sch.gapSeconds } : {}),
      ...(scheduled && sch.style ? { style: sch.style } : {}),
    },
  };

  batchRunning = true;
  stopRequested = false;
  broadcast('batch', { running: true });

  let sent = 0;
  let failed = 0;

  try {
    if (!runCfg.dryRun) {
      if (targets.some((t) => t.kind === 'whatsapp')) {
        await ensureConnect();
        await waitForConnection();
      }
      for (const target of targets) await verifyTarget(target);
    }

    const style = runCfg.batch.style ?? 'quiz';
    const sel = cfg.selection;
    const quotaTotal = (sel.quotas ?? []).reduce((n, q) => n + q.count, 0);
    const scope = (sel.quotas ?? []).length
      ? `mix: ${sel.quotas.map((q) => `${q.count} ${q.module}`).join(' + ')}`
      : sel.modules.length || sel.subtopics.length
        ? `filtered to ${[...sel.modules, ...sel.subtopics].join(', ')}`
        : 'all topics';
    log('info', `Run${scheduled ? ' (scheduled)' : ''}: ${quotaTotal || runCfg.batch.size} questions (${style}, ${scope}, ${runCfg.batch.gapSeconds}s gap) → ${targets.map(describeTarget).join(' + ')}`);

    for (const [i, target] of targets.entries()) {
      if (stopRequested) break;
      log('info', `── Target ${i + 1}/${targets.length}: ${describeTarget(target)} ──`);
      broadcast('progress', {
        type: 'targetStart',
        targetKey: target.key,
        label: describeTarget(target),
        index: i + 1,
        total: targets.length,
      });

      const rawSend = makeSender({
        cfg: runCfg,
        target,
        getSock: () => sock,
        ensureConnected: () => ensureConnect(),
        log,
      });

      const send = async (content, meta) => {
        // Dry run must never touch WhatsApp: show what would go out instead.
        if (runCfg.dryRun) {
          log('info', `[dry run] ${describeContent(content).split('\n')[0]}`);
          return;
        }
        return rawSend(content, meta);
      };

      const result = await runBatch({
        cfg: runCfg,
        targetKey: target.key,
        send,
        commit: !runCfg.dryRun,
        shouldStop: () => stopRequested,
        onEvent: (e) => broadcast('progress', { ...e, targetKey: target.key, label: describeTarget(target) }),
      });

      sent += result.sent;
      failed += result.failed ?? 0;
      if (!runCfg.dryRun) {
        recordRunHistory({ targetKey: target.key, label: describeTarget(target), result, reason });
      }

      if (result.summaryError) {
        log('err', `${describeTarget(target)} — the closing score poll could not be sent: ${result.summaryError}`);
      }
      if (result.finished) {
        log('warn', (cfg.selection?.quotas ?? []).length
          ? `${describeTarget(target)} — no unsent questions left for the current mix.`
          : `${describeTarget(target)} — every question has already been posted.`);
      } else {
        log('ok', `${describeTarget(target)} — ${result.sent} sent${result.failed ? `, ${result.failed} failed` : ''}${result.stopped ? ' (stopped early)' : ''}. Covered ${result.covered}/${result.total}.`);
      }
      const short = (result.composition ?? []).filter((c) => c.picked < c.requested);
      if (short.length) {
        log('warn', `Mix short: ${short.map((c) => `${c.module} ${c.picked}/${c.requested}`).join(', ')} — not enough unsent questions in that subject.`);
      }
      if (result.unconfirmed?.length) {
        log('warn', `${describeTarget(target)} — ${result.unconfirmed.length} post(s) were not confirmed by WhatsApp: Q${result.unconfirmed.join(', Q')}. Repost them from the "Missed a question" box.`);
      }
    }

    clearBankCache();
    log('ok', `Run finished — ${sent} post(s) sent to ${targets.length} target(s)${failed ? `, ${failed} failed` : ''}.`);
  } catch (err) {
    log('err', err.message);
    broadcast('progress', { type: 'error', message: err.message });
  } finally {
    batchRunning = false;
    broadcast('batch', { running: false });
    pushStatus();
  }
}

async function addChannel(link) {
  if (!link) throw new Error('Paste your channel invite link first.');
  await ensureConnect();
  await waitForConnection();
  const code = String(link).replace(/.*channel\//i, '').replace(/[^0-9A-Za-z]/g, '');
  const meta = await sock.newsletterMetadata('invite', code);
  if (!meta?.id) throw new Error('Could not resolve that link. Is the channel public?');

  const channels = cfg.channels.map((c) => ({ ...c }));
  if (channels.some((c) => c.jid === meta.id)) throw new Error('That channel is already in the list.');
  channels.push({ jid: meta.id, name: meta.name ?? '', enabled: true });

  saveConfigPatch({ channels, channelJid: channels[0].jid });
  log('ok', `Channel added: ${meta.name ?? ''} → ${meta.id}`);
  return meta;
}

function removeChannel(jid) {
  const channels = cfg.channels.filter((c) => c.jid !== jid);
  saveConfigPatch({ channels, channelJid: channels[0]?.jid ?? '' });
  log('warn', `Channel removed: ${jid}`);
}

async function discoverTelegramChats() {
  const identity = await telegramMe(cfg);
  log('info', `Telegram bot: @${identity?.username ?? identity?.id ?? '?'}`);

  const updates = await telegramUpdates(cfg);
  const found = chatsFromUpdates(updates);
  if (!found.length) {
    throw new Error('No chats found. Add the bot as an admin of your channel, then post something in it (or remove and re-add the bot) and try again.');
  }

  const chats = cfg.telegram.chats.map((c) => ({ ...c }));
  let added = 0;
  for (const f of found) {
    if (chats.some((c) => c.chatId === f.chatId)) continue;
    chats.push({ chatId: f.chatId, name: f.name, enabled: true });
    added += 1;
  }

  saveConfigPatch({ telegram: { ...cfg.telegram, enabled: true, chats } });
  log('ok', added ? `Found ${added} new Telegram chat(s).` : 'No new Telegram chats (all already listed).');
  return chats;
}

async function testTarget(key) {
  const target = targetByKey(cfg, key);
  if (!target) throw new Error('That channel is no longer in the list.');
  if (target.kind === 'whatsapp') {
    await ensureConnect();
    await waitForConnection();
    await verifyTarget(target);
  }

  const send = makeSender({
    cfg,
    target,
    getSock: () => sock,
    ensureConnected: () => ensureConnect(),
    log,
  });
  await send(
    { text: `${cfg.headerEmoji} *Test message*\n\nThis is where the daily quiz will be posted. Ignore me 🙂` },
    { phase: 'summary' },
  );
  log('ok', `Test message sent to ${describeTarget(target)}.`);
}

/**
 * Send one question from the most recent run again, by the number printed in
 * its header (Q40). Runs number their questions 1..N, so "40" means the 40th
 * question of that run — not the 40th question of the whole bank. The run is
 * recorded when it starts, which is what makes that lookup possible. Used to
 * fill a gap when a post never arrived.
 */
async function repostQuestion(key, position) {
  const target = targetByKey(cfg, key);
  if (!target) throw new Error('Pick a channel first.');
  const num = Number(position);
  if (!Number.isInteger(num) || num < 1) throw new Error('Enter a question number, e.g. 40.');

  // Same queue the run used, so a topic filter still applies.
  const pool = loadPool(cfg, key);
  const ids = Array.isArray(pool.target.run?.ids) ? pool.target.run.ids : [];
  if (!ids.length) {
    throw new Error('No run has been recorded for this channel yet — start a run, then repost from it.');
  }
  if (num > ids.length) {
    throw new Error(`The last run had ${ids.length} questions — pick a number from 1 to ${ids.length}.`);
  }

  const id = ids[num - 1];
  const question = pool.questions.find((q) => q.id === id);
  if (!question) {
    throw new Error(`Q${num} from the last run is not in the bank any more (bank files changed?).`);
  }

  if (target.kind === 'whatsapp') {
    await ensureConnect();
    await waitForConnection();
  }

  const send = makeSender({
    cfg,
    target,
    getSock: () => sock,
    ensureConnected: () => ensureConnect(),
    log,
  });

  const ctx = { cfg, number: num, order: optionOrder(question, cfg.shuffleOptions) };
  const contents = buildContents(question, ctx);
  for (const content of contents) await send(content, { phase: 'summary' });

  // It was already marked as posted in the run that skipped it; make sure it
  // stays marked even if it somehow was not.
  const state = loadState(cfg.channels[0]?.jid ?? '');
  const record = targetState(state, target.key);
  if (!record.postedIds.includes(question.id)) {
    record.postedIds.push(question.id);
    record.history.push({ id: question.id, at: new Date().toISOString(), repost: true });
    saveState(state);
  }
  clearBankCache();

  const text = question.question.en || question.question.hi || '';
  log('ok', `Reposted Q${num} to ${describeTarget(target)} — ${text.slice(0, 70)}`);
  return { number: num, question: text };
}

/**
 * Requests an 8-digit pairing code so a phone can link itself without scanning
 * a QR code displayed on its own screen.
 */
async function startPairing(phone) {
  if (status === 'connected' && sock?.user) {
    log('info', 'WhatsApp is already linked — no pairing code is needed.');
    return;
  }
  saveConfigPatch({ loginMethod: 'pairing', phoneNumber: phone });
  pairingPhone = phone;
  pairingCode = null;
  pairingError = null;
  pushStatus();
  log('info', `Requesting a pairing code for +${phone}…`);
  // Let any in-flight connection finish tearing down, then start from clean
  // credentials (ensureConnect drops an unfinished link).
  for (let i = 0; i < 20 && connecting; i += 1) await sleep(250);
  await ensureConnect({ force: true });
}

async function unlink() {
  log('warn', 'Unlinking WhatsApp — a fresh QR will appear.');
  destroySocket();
  generation++;
  clearTimeout(reconnectTimer);
  status = 'disconnected';
  qrDataUrl = null;
  pairingCode = null;
  pairingPhone = null;
  pairingError = null;
  me = null;
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
  pushStatus();
  await sleep(500);
  await ensureConnect({ force: true });
}

// ---------------------------------------------------------------- server

/**
 * Only answer the local panel. Without this, any website open in the same
 * browser could POST to /api/batch or read /api/status (which carries the
 * Telegram token); a Host check also blocks DNS-rebinding tricks.
 */
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  ...(HOST !== '0.0.0.0' ? [`${HOST}:${PORT}`] : []),
]);

function isTrustedRequest(req) {
  // If running on a cloud container with public host (0.0.0.0 or SERVER_PORT configured), allow cloud domain traffic
  if (process.env.SERVER_PORT || HOST === '0.0.0.0') return true;

  const host = String(req.headers.host ?? '');
  if (!ALLOWED_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!ALLOWED_HOSTS.has(new URL(origin).host)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  if (!isTrustedRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden — open the panel from http://127.0.0.1:' + PORT);
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname;

  try {
    if (route === '/' || route === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(UI_FILE));
    }

    if (route === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return;
    }

    if (route === '/api/status') return sendJson(res, 200, statusPayload());

    if (route === '/api/topics') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const key = body.target ?? url.searchParams.get('target') ?? '';
      // The UI passes the selection it currently has on screen so it can show
      // the live "N available" count before anything is saved.
      const selection = body.selection ?? cfg.selection;
      return sendJson(res, 200, { ok: true, ...topicInventory({ ...cfg, selection }, key) });
    }

    if (route === '/api/connect' && req.method === 'POST') {
      ensureConnect().catch((e) => log('err', e.message));
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/reconnect' && req.method === 'POST') {
      reconnectDelay = 3000;
      ensureConnect({ force: true }).catch((e) => log('err', e.message));
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/pair' && req.method === 'POST') {
      const { phone } = await readBody(req);
      const digits = String(phone ?? '').replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Enter the full number with country code, e.g. 919812345678.',
        });
      }
      startPairing(digits).catch((e) => {
        pairingError = e.message;
        log('err', e.message);
        pushStatus();
      });
      return sendJson(res, 200, { ok: true, phone: digits });
    }

    if (route === '/api/unlink' && req.method === 'POST') {
      unlink().catch((e) => log('err', e.message));
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/preview' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, previewNext(cfg, body?.target ?? ''));
    }

    if (route === '/api/settings' && req.method === 'POST') {
      const patch = await readBody(req);
      saveConfigPatch(patch);
      return sendJson(res, 200, { ok: true, config: publicConfig() });
    }

    if ((route === '/api/channels/add' || route === '/api/resolve') && req.method === 'POST') {
      const { link } = await readBody(req);
      const meta = await addChannel(link);
      return sendJson(res, 200, { ok: true, meta });
    }

    if (route === '/api/channels/remove' && req.method === 'POST') {
      const { jid } = await readBody(req);
      removeChannel(jid);
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/telegram/discover' && req.method === 'POST') {
      const chats = await discoverTelegramChats();
      return sendJson(res, 200, { ok: true, chats });
    }

    if (route === '/api/target/test' && req.method === 'POST') {
      const { key } = await readBody(req);
      await testTarget(key);
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/repost' && req.method === 'POST') {
      const { key, position } = await readBody(req);
      const result = await repostQuestion(key, position);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (route === '/api/forward/preview' && req.method === 'POST') {
      const body = await readBody(req);
      const report = await runForward({ dryRun: true, sourceJid: body?.source ?? null, ignoreWindow: true });
      return sendJson(res, 200, { ok: true, ...report });
    }

    if (route === '/api/forward/now' && req.method === 'POST') {
      const body = await readBody(req);
      runForward({ sourceJid: body?.source ?? null }).catch((err) => log('err', `Forwarder: ${err.message}`));
      return sendJson(res, 200, { ok: true, started: true });
    }

    if (route === '/api/forward/source/add' && req.method === 'POST') {
      const { link } = await readBody(req);
      const meta = await addForwardSource(link);
      return sendJson(res, 200, { ok: true, meta });
    }

    if (route === '/api/forward/source/remove' && req.method === 'POST') {
      const { jid } = await readBody(req);
      removeForwardSource(jid);
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/batch' && req.method === 'POST') {
      // Not awaited: the run reports progress over SSE. The catch keeps a
      // double-click from becoming an unhandled rejection that kills the panel.
      startBatch().catch((err) => log('err', err.message));
      return sendJson(res, 200, { ok: true, started: true });
    }

    if (route === '/api/stop' && req.method === 'POST') {
      stopRequested = true;
      log('warn', 'Stop requested — finishing the current post.');
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/reset-progress' && req.method === 'POST') {
      const { key } = await readBody(req);
      const state = loadState(cfg.channels[0]?.jid ?? '');
      if (key && state.targets[key]) {
        state.targets[key].postedIds = [];
        state.targets[key].pending = null;
        log('warn', 'Progress reset for that channel — every question is available again.');
      } else {
        for (const target of Object.values(state.targets)) {
          target.postedIds = [];
          target.pending = null;
        }
        log('warn', 'Progress reset for every channel — all questions are available again.');
      }
      saveState(state);
      clearBankCache();
      pushStatus();
      return sendJson(res, 200, { ok: true });
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    log('err', err.message);
    sendJson(res, 500, { error: err.message });
  }
});

// ---------------------------------------------------------------- boot

try {
  acquireLock('control panel');
} catch (err) {
  console.error('\n  ⛔ ' + err.message + '\n');
  process.exit(1);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  ⛔ Port ${PORT} is already in use.`);
    console.error('     The Control Panel is probably already open in another window.');
    console.error(`     Either use that one, or open http://127.0.0.1:${PORT} in your browser.`);
    console.error('');
  } else {
    console.error(`\n  ⛔ ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │   Question Poster — Control Panel            │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
  console.log(`   Open:  ${url}`);
  console.log('');
  console.log('   Keep this window open. Close it to stop.');
  console.log('');
  const targets = allTargets(cfg);
  log('info', `Loaded ${getBank(targets[0]?.key ?? '').queue.length} questions from ${cfg.bankPaths.length} bank file(s).`);
  log('info', targets.length
    ? `Targets: ${targets.map((t) => `${describeTarget(t)}${t.enabled ? '' : ' (off)'}`).join(', ')}`
    : 'No channel configured yet.');
  if (process.env.NO_CONNECT !== 'true') {
    ensureConnect().catch((e) => log('err', e.message));
  }

  scheduleForwarder();
  armSchedule();

  if (process.env.NO_BROWSER !== 'true') {
    const opener = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(opener, (err2) => { if (err2) console.log(`   (open ${url} in your browser)`); });
  }
});
