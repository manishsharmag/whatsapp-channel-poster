import fs from 'node:fs';
import path from 'node:path';

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];
const BLANK = '______';

// A trailing "(Set #7)" / "(Practice Drill #3)" marker added by the volume banks
// when they repeat the same question once per practice set.
const SET_TAG = /[ \t]*\([^()]*(?:set|drill|part|practice|series|paper)[^()]*\d[^()]*\)[ \t]*$/i;
const HASH_TAG = /[ \t]*\([^()]*#\s*\d+[^()]*\)[ \t]*$/i;

/**
 * Drop the practice-set tag from a question.
 *
 * The volume banks repeat every question once per set, tagging each copy, e.g.
 * "... (Set #7)" or "... (Practice Drill #3)". The tag is extraction noise, so
 * removing it both collapses the copies into one and stops the posted question
 * from carrying a meaningless "(Set #7)".
 *
 * Deliberately narrow: a genuine marker such as "(use π = 22/7)" is left alone.
 */
export function stripSetTag(text) {
  return String(text).replace(SET_TAG, '').replace(HASH_TAG, '').trim();
}

function hasBlank(text) {
  return /_{2,}/.test(text);
}

function endsCleanly(text) {
  return /[.?!:\u0964"'\u201d)\]]$/.test(text.trim());
}

/**
 * Some banks lost the "______" fill-in-the-blank marker from the English text
 * during PDF extraction, while the Hindi kept its own marker, e.g.
 *
 *   en: "Haryana is the first state to launch"
 *   hi: "हरियाणा ____________ शुरू करनेवाला पहला राज्य है।"
 *
 * In every such case the English text stops exactly where the blank belongs,
 * so we put the marker back. If the English is already a complete sentence we
 * leave it alone.
 */
function restoreEnglishBlank(en, hi) {
  if (!en || !hi) return en;
  if (hasBlank(en) || !hasBlank(hi)) return en;
  if (endsCleanly(en)) return en;
  return `${en} ${BLANK}`;
}

/**
 * Comparison key for spotting two options that literally read the same.
 * Deliberately gentle: it must NOT treat "-3" and "3", or "y = b" and
 * "y = -b", as duplicates, because those are real, different answers.
 */
function optionKey(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True when two options read the same, e.g. "7 percent" listed twice. */
function hasDuplicateOptions(options) {
  const seen = new Set();
  for (const o of options) {
    const key = optionKey(o.en || o.hi);
    if (!key) continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function stripOptionPrefix(text) {
  return String(text).replace(/^\s*(?:\(?[A-Fa-f1-9]\)?[).:]\s*)/, '').trim();
}

function norm(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\u0900-\u097F ]/g, '').trim();
}

function toText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') return String(value.en ?? value.hi ?? value.text ?? '').trim();
  return String(value).trim();
}

/** Build an aligned list of bilingual options: [{ en, hi }] */
function buildOptions(raw) {
  let list = [];

  if (Array.isArray(raw)) {
    list = raw.map((v) =>
      v && typeof v === 'object' ? { en: toText(v.en ?? v.text), hi: toText(v.hi) } : { en: String(v), hi: '' });
  } else if (raw && typeof raw === 'object') {
    const keys = OPTION_KEYS.filter((k) => raw[k] !== undefined);
    const use = keys.length ? keys : Object.keys(raw);
    list = use.map((k) => {
      const v = raw[k];
      return v && typeof v === 'object' ? { en: toText(v.en ?? v.text), hi: toText(v.hi) } : { en: String(v), hi: '' };
    });
  }

  return list
    .map((o) => ({ en: stripOptionPrefix(o.en), hi: stripOptionPrefix(o.hi) }))
    .filter((o) => o.en || o.hi);
}

function findCorrectIndex(record, options) {
  const correctText = record.correct_option_text ?? record.correctOption;
  if (correctText) {
    const target = norm(correctText);
    let idx = options.findIndex((o) => norm(o.en) === target);
    if (idx < 0) idx = options.findIndex((o) => norm(o.en).startsWith(target) || target.startsWith(norm(o.en)));
    if (idx >= 0) return idx;
  }

  const a = record.correct_answer ?? record.answer ?? record.correct ?? record.ans;
  if (a === undefined || a === null) return -1;
  const s = String(a).trim();

  if (s.length === 1) {
    const li = OPTION_KEYS.indexOf(s.toUpperCase());
    if (li >= 0 && li < options.length) return li;
  }

  const n = Number.parseInt(s, 10);
  if (!Number.isNaN(n)) {
    if (n >= 1 && n <= options.length) return n - 1;
    if (n >= 0 && n < options.length) return n;
  }
  return -1;
}

function normalizeRecord(record, index, tag) {
  // Strip the practice-set tag first: it ends with ")", which would otherwise
  // make a truncated question look like a complete sentence.
  const questionHi = stripSetTag(toText(record.question_hi));
  const questionEn = restoreEnglishBlank(
    stripSetTag(toText(record.question_en ?? record.question ?? record.q ?? record.text)),
    questionHi,
  );
  if (!questionEn && !questionHi) return null;

  const options = buildOptions(record.options ?? record.options_raw ?? record.choices);
  if (options.length < 2) return null;

  const correctIndex = findCorrectIndex(record, options);
  if (correctIndex < 0) return null;

  const explanation = record.explanation && typeof record.explanation === 'object'
    ? { en: toText(record.explanation.en), hi: toText(record.explanation.hi) }
    : { en: toText(record.explanation), hi: '' };

  return {
    id: `${tag}::${record.id ?? record.qid ?? index + 1}`,
    module: toText(record.module ?? record.subject ?? record.main_cat ?? record.main_top ?? record.main_c ?? record.section) || 'General',
    subtopic: toText(record.subtopic ?? record.topic ?? record.sub_cat ?? record.sub_top ?? record.sub_c),
    question: { en: questionEn, hi: questionHi },
    options,
    correctIndex,
    explanation,
  };
}

/**
 * Load and normalise every bank.
 *
 * @param skipDuplicateOptions  drop questions whose options read the same twice
 *                              (bad PDF extraction), since they are unanswerable
 *                              and look broken in the channel.
 */
export function loadBanks(bankPaths, { skipDuplicateOptions = true } = {}) {
  const all = [];
  const seen = new Set();
  let duplicates = 0;
  let skipped = 0;
  let badOptions = 0;

  for (const bankPath of bankPaths) {
    const tag = path.basename(bankPath).replace(/\.json$/i, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 24).toLowerCase();
    const data = JSON.parse(fs.readFileSync(bankPath, 'utf8').replace(/^\uFEFF/, ''));
    const records = Array.isArray(data) ? data : data.questions ?? data.items ?? [];
    if (!Array.isArray(records)) continue;

    for (const [i, record] of records.entries()) {
      const q = normalizeRecord(record, i, tag);
      if (!q) {
        skipped++;
        continue;
      }
      if (skipDuplicateOptions && hasDuplicateOptions(q.options)) {
        badOptions++;
        continue;
      }
      const key = norm(q.question.en || q.question.hi);
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      all.push(q);
    }
  }

  return { questions: all, duplicates, skipped, badOptions };
}

/** Interleave modules round-robin so the channel gets variety. */
export function buildQueue(questions, rotateModules) {
  if (!rotateModules) return questions;

  const groups = new Map();
  for (const q of questions) {
    if (!groups.has(q.module)) groups.set(q.module, []);
    groups.get(q.module).push(q);
  }

  const lists = [...groups.values()];
  const out = [];
  for (let i = 0; ; i++) {
    let added = false;
    for (const list of lists) {
      if (list[i]) {
        out.push(list[i]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}
