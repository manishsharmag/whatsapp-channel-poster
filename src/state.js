import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './config.js';

const DIR = path.join(projectRoot(), 'state');
const FILE = path.join(DIR, 'state.json');
const BACKUP = path.join(DIR, 'state.backup.json');

/** How many finished runs are kept for the "Recent runs" list. */
const MAX_RUNS = 60;

const blankTarget = () => ({ postedIds: [], pending: null, history: [], run: null, daily: null });

/** Everything that is not per-channel lives here, so it cannot be lost on reload. */
function blank(state) {
  return {
    ...state,
    version: 2,
    targets: state.targets ?? {},
    forward: state.forward ?? { sources: {} },
    runs: Array.isArray(state.runs) ? state.runs : [],
    schedule: state.schedule && typeof state.schedule === 'object' ? state.schedule : {},
  };
}

// Reserved key holding old single-channel progress until we know the channel.
const UNCLAIMED = '__unclaimed__';

export function stateFile() {
  return FILE;
}

/**
 * Progress is kept PER TARGET.
 *
 * Each channel needs its own "already posted" list: a brand-new channel has to
 * start from question 1 even though the original channel has seen all of them.
 * A target key is "wa:<channel jid>" or "tg:<telegram chat id>".
 *
 * Version 1 of this file held a single flat record for the one channel; the
 * first load moves it under that channel's key so no progress is lost.
 */
export function loadState(legacyJid = '') {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    raw = {};
  }

  if (raw && typeof raw.targets === 'object' && raw.targets !== null) {
    const targets = {};
    for (const [key, value] of Object.entries(raw.targets)) {
      targets[key] = { ...blankTarget(), ...(value ?? {}) };
    }
    const state = blank({
      targets,
      forward: raw.forward ?? { sources: {} },
      runs: raw.runs,
      schedule: raw.schedule,
    });
    if (legacyJid) claimLegacy(state, legacyJid);
    return state;
  }

  const targets = {};
  const hadProgress = Array.isArray(raw?.postedIds) && raw.postedIds.length > 0;
  if (hadProgress) {
    const record = {
      postedIds: raw.postedIds,
      pending: raw.pending ?? null,
      history: Array.isArray(raw.history) ? raw.history : [],
    };
    // Never drop the old progress: park it under a reserved key until a caller
    // tells us which channel it belonged to.
    targets[legacyJid ? `wa:${legacyJid}` : UNCLAIMED] = record;
  }
  return blank({ targets });
}

/**
 * Move old single-channel progress onto the right channel key, once.
 * The legacy file had no channel of its own, so it belongs to the first
 * (original) channel.
 */
export function claimLegacy(state, jid) {
  const parked = state.targets?.[UNCLAIMED];
  if (!parked) return false;
  const key = `wa:${jid}`;
  const existing = state.targets[key];
  if (existing && existing.postedIds?.length) {
    // Already has its own progress — merge the parked ids in rather than lose them.
    for (const id of parked.postedIds ?? []) {
      if (!existing.postedIds.includes(id)) existing.postedIds.push(id);
    }
  } else {
    state.targets[key] = { ...blankTarget(), ...parked };
  }
  delete state.targets[UNCLAIMED];
  return true;
}

/** The record for one target, created on first use. */
export function targetState(state, key) {
  if (!state.targets[key]) state.targets[key] = blankTarget();
  return state.targets[key];
}

/** Local calendar day, e.g. "2026-10-29". */
export function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Number for the next one-at-a-time post ("quiz" mode: question at 08:00,
 * answer at 20:00). It counts within the local day and starts again at 1 after
 * midnight, so a daily quiz never prints a bank position like Q4688.
 *
 * The batch poster does not use this: a run always numbers 1..N itself.
 */
export function nextDailyNumber(target, date = new Date()) {
  const day = dayKey(date);
  if (target.daily?.day !== day) target.daily = { day, last: 0 };
  target.daily.last += 1;
  return target.daily.last;
}

export function saveState(state) {
  fs.mkdirSync(DIR, { recursive: true });
  const targets = state.targets ?? {};
  for (const value of Object.values(targets)) {
    if (value.history?.length > 500) value.history = value.history.slice(-500);
  }
  if (Array.isArray(state.runs) && state.runs.length > MAX_RUNS) {
    state.runs = state.runs.slice(-MAX_RUNS);
  }

  // One backup per day, taken before the day's first write. If the live file is
  // ever damaged by something the atomic write cannot protect against (a bad
  // edit, a sync tool, disk trouble), there is still a copy from yesterday.
  try {
    const today = dayKey();
    const stamp = fs.existsSync(BACKUP) ? dayKey(new Date(fs.statSync(BACKUP).mtimeMs)) : '';
    if (stamp !== today && fs.existsSync(FILE)) fs.copyFileSync(FILE, BACKUP);
  } catch { /* a backup is a bonus, never a reason to fail a save */ }

  // Write-then-rename: a crash mid-write can no longer leave a 0-byte
  // state.json that would lose every channel's posting history.
  const body = JSON.stringify(blank(state), null, 2);
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, FILE);
}

/** Add one finished run to the history the panel shows. */
export function recordRun(state, entry) {
  if (!Array.isArray(state.runs)) state.runs = [];
  state.runs.push({ at: new Date().toISOString(), ...entry });
  if (state.runs.length > MAX_RUNS) state.runs = state.runs.slice(-MAX_RUNS);
  return entry;
}

/**
 * One-time move from the old single-channel file. Safe to call often: it does
 * nothing once the file is already in the new shape.
 */
export function migrateState(legacyJid) {
  if (!legacyJid) return false;
  const state = loadState(legacyJid);
  const before = Object.keys(state.targets).length;
  if (before === 0) return false;
  saveState(state);
  return true;
}
