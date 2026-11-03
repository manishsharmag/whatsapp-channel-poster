import { isValidChannelJid } from './config.js';

/**
 * A "target" is anywhere a run can be posted: a WhatsApp channel or a Telegram
 * chat/channel. Progress is tracked per target (see state.js).
 */

export function waTarget(jid, name = '', enabled = true) {
  // Never show a bare "1203…@newsletter" as the channel name. If WhatsApp has
  // not given us the real title yet, a short "Channel …1234" is still readable.
  const clean = String(name ?? '').trim();
  const label = clean && clean !== jid
    ? clean
    : `Channel …${String(jid).replace(/@.*$/, '').slice(-4)}`;
  return { kind: 'whatsapp', key: `wa:${jid}`, jid, label, enabled };
}

export function tgTarget(chatId, name = '', enabled = true) {
  return { kind: 'telegram', key: `tg:${chatId}`, chatId, label: name || chatId, enabled };
}

/** Every configured target, enabled or not (used by the settings UI). */
export function allTargets(cfg) {
  const out = [];
  for (const c of cfg.channels ?? []) {
    if (isValidChannelJid(c.jid)) out.push(waTarget(c.jid, c.name, c.enabled !== false));
  }
  const tg = cfg.telegram ?? {};
  if (tg.botToken) {
    for (const c of tg.chats ?? []) {
      if (c.chatId) out.push(tgTarget(c.chatId, c.name, tg.enabled !== false && c.enabled !== false));
    }
  }
  return out;
}

/** Targets a run should actually post to. */
export function enabledTargets(cfg) {
  return allTargets(cfg).filter((t) => t.enabled);
}

export function targetByKey(cfg, key) {
  return allTargets(cfg).find((t) => t.key === key) ?? null;
}

/** Human label for logs, e.g. "WhatsApp: HSSC GROUP D" or "Telegram: @mychannel". */
export function describeTarget(target) {
  return `${target.kind === 'telegram' ? 'Telegram' : 'WhatsApp'}: ${target.label}`;
}

/**
 * A short, stable fingerprint of what a target will receive, so the UI can warn
 * that e.g. Telegram cannot carry 6-option polls.
 */
export function targetLimits(target) {
  if (target.kind === 'telegram') {
    return { maxOptions: 10, maxQuestion: 300, maxOption: 100, supportsQuiz: true };
  }
  return { maxOptions: 12, maxQuestion: 255, maxOption: 100, supportsQuiz: true };
}
