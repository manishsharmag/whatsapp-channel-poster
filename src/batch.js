import { loadBanks, buildQueue } from './bank.js';
import { loadState, saveState, targetState } from './state.js';
import {
  buildQuestionPost,
  buildAnswerPost,
  buildFullPost,
  buildBatchIntro,
  buildSummaryContent,
  buildPoll,
  buildQuiz,
  correctLetterOf,
  optionOrder,
} from './format.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Stop after this many questions failed in a row — the connection is gone. */
const MAX_CONSECUTIVE_FAILURES = 3;

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The original single channel, used to claim old progress on first load. */
function legacyJidOf(cfg) {
  return cfg.channels?.[0]?.jid ?? cfg.channelJid ?? '';
}

/** Restrict the queue to the chosen modules / subtopics (empty = everything). */
export function selectQueue(queue, cfg) {
  // A quota mix replaces the topic filter: the mix itself says which subjects
  // and how many of each. Keeping both would silently drop a quota subject that
  // is not ticked in the filter below it.
  if ((cfg.selection?.quotas ?? []).length) return queue;

  const modules = cfg.selection?.modules ?? [];
  const subtopics = cfg.selection?.subtopics ?? [];
  if (!modules.length && !subtopics.length) return queue;

  // Union: a question is included when its module OR its subtopic is selected,
  // so "General Science" and "Chemistry & Environment" can be mixed freely and
  // picking one subtopic gives exactly that subtopic.
  const wantModules = new Set(modules);
  const wantSubtopics = new Set(subtopics);
  return queue.filter(
    (q) => wantModules.has(q.module) || wantSubtopics.has(q.subtopic || ''),
  );
}

function interleave(lists) {
  const out = [];
  const depth = Math.max(0, ...lists.map((list) => list.length));
  for (let i = 0; i < depth; i += 1) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out;
}

/**
 * Turn "10 Quantitative, 10 Reasoning, …" into that many questions per module.
 *
 * Pure on purpose: no bank or state access, so the rule is easy to test and it
 * can also answer "how many can this mix actually send right now".
 *
 * @param queue  candidate questions, already limited to unsent ones by caller
 * @param quotas [{ module, count }]
 * @param random shuffle inside each module (selection mode "random")
 * @param order  "grouped" = one subject block after another, "mixed" = take one
 *               from each subject in turn
 */
export function pickWithQuotas(queue, quotas, { random = false, order = 'grouped' } = {}) {
  // Merge a subject that is listed twice instead of picking the same questions
  // again for the second entry. config.js does this too; keeping it here means
  // the rule cannot be bypassed by a direct caller.
  const merged = [];
  const at = new Map();
  for (const item of quotas ?? []) {
    const module = String(item?.module ?? '').trim();
    const count = Math.max(0, Math.floor(Number(item?.count) || 0));
    if (!module || !count) continue;
    if (at.has(module)) merged[at.get(module)].count += count;
    else {
      at.set(module, merged.length);
      merged.push({ module, count });
    }
  }

  const lists = merged.map(({ module, count }) => {
    let pool = queue.filter((q) => q.module === module);
    if (random) pool = shuffle(pool);
    return { module, requested: count, picked: pool.slice(0, count) };
  });

  const questions = order === 'mixed'
    ? interleave(lists.map((list) => list.picked))
    : lists.flatMap((list) => list.picked);

  return {
    questions,
    composition: lists.map((list) => ({
      module: list.module,
      requested: list.requested,
      picked: list.picked.length,
    })),
  };
}

/** What this configuration would post now — quota mix first, then plain filter. */
function pickCandidates(pool, cfg) {
  const quotas = cfg.selection?.quotas ?? [];
  const unsent = pool.queue.filter((q) => !pool.posted.has(q.id));

  if (quotas.length) {
    return pickWithQuotas(unsent, quotas, {
      random: cfg.selection?.mode === 'random',
      order: cfg.selection?.quotaOrder,
    });
  }

  const questions = cfg.selection?.mode === 'random' ? shuffle(unsent) : unsent;
  return { questions, composition: null };
}

/**
 * Load the banks plus the progress record for ONE target.
 *
 * @param targetKey  "wa:<channel jid>" or "tg:<chat id>"
 */
export function loadPool(cfg, targetKey = '') {
  const { questions, duplicates, skipped, badOptions } = loadBanks(cfg.bankPaths, {
    skipDuplicateOptions: cfg.skipDuplicateOptions !== false,
  });
  const state = loadState(legacyJidOf(cfg));
  const target = targetState(state, targetKey || `wa:${legacyJidOf(cfg)}`);
  const posted = new Set(target.postedIds);
  const queue = selectQueue(buildQueue(questions, cfg.rotateModules), cfg);
  // Count progress against this target's queue only, so removing duplicate ids
  // from the bank can never make the "posted" number exceed the real total.
  const covered = queue.reduce((n, q) => n + (posted.has(q.id) ? 1 : 0), 0);
  return {
    questions,
    queue,
    duplicates,
    skipped,
    badOptions,
    state,
    target,
    targetKey,
    posted,
    covered,
  };
}

/** Modules and subtopics with how many questions each target has left. */
export function topicInventory(cfg, targetKey = '') {
  // Always inventory the WHOLE bank. If this used the current filter, picking
  // one subtopic would make every other topic vanish from the picker.
  const pool = loadPool({ ...cfg, selection: { modules: [], subtopics: [], mode: 'sequence' } }, targetKey);
  const modules = new Map();
  const subtopics = new Map();

  for (const q of pool.queue) {
    const left = pool.posted.has(q.id) ? 0 : 1;
    const m = modules.get(q.module) ?? { total: 0, unsent: 0 };
    m.total += 1;
    m.unsent += left;
    modules.set(q.module, m);

    const key = q.subtopic || '';
    const s = subtopics.get(key) ?? { total: 0, unsent: 0, modules: new Set() };
    s.total += 1;
    s.unsent += left;
    s.modules.add(q.module);
    subtopics.set(key, s);
  }

  // "available" is the only number that follows the current selection.
  const selectedQueue = selectQueue(pool.queue, cfg);
  const unsent = selectedQueue.filter((q) => !pool.posted.has(q.id));
  const available = (cfg.selection?.quotas ?? []).length
    ? pickWithQuotas(unsent, cfg.selection.quotas, { order: cfg.selection.quotaOrder }).questions.length
    : unsent.length;

  return {
    modules: [...modules.entries()]
      .map(([name, v]) => ({ name, total: v.total, unsent: v.unsent }))
      .sort((a, b) => b.total - a.total),
    subtopics: [...subtopics.entries()]
      .map(([name, v]) => ({ name, total: v.total, unsent: v.unsent, modules: [...v.modules] }))
      .sort((a, b) => b.total - a.total),
    available,
    selected: selectedQueue.length,
    total: pool.queue.length,
    covered: pool.covered,
  };
}

function useContext(q, cfg, number) {
  return { cfg, number, order: optionOrder(q, cfg.shuffleOptions) };
}

/** "quiz", "poll" or "text" — anything unrecognised falls back to plain text. */
function postStyle(cfg) {
  const style = cfg.batch.style ?? 'text';
  return style === 'quiz' || style === 'poll' ? style : 'text';
}

/** Contents for the question itself. */
export function questionContents(q, ctx) {
  const style = postStyle(ctx.cfg);
  if (style === 'quiz') return [{ quiz: buildQuiz(q, ctx) }];
  if (style === 'poll') return [{ poll: buildPoll(q, ctx) }];
  return [{ text: buildQuestionPost(q, ctx) }];
}

export function answerContent(q, ctx) {
  return { text: buildAnswerPost(q, ctx) };
}

/** Everything to post for one question, in order. */
export function buildContents(q, ctx) {
  const out = questionContents(q, ctx);
  if (ctx.cfg.batch.includeAnswer !== false) out.push(answerContent(q, ctx));
  return out;
}

function describePoll(spec, isQuiz) {
  const lines = [isQuiz
    ? `📊 QUIZ — correct answer: ${LETTERS[spec.correctIndex]}`
    : '📊 POLL'];
  lines.push(spec.name, '');
  spec.values.forEach((value, i) => {
    lines.push(`   ${isQuiz && i === spec.correctIndex ? '✓' : '○'} ${value}`);
  });
  return lines.join('\n');
}

/** Human-readable version of what will be sent, for logs and the CLI. */
export function describeContent(content) {
  if (content?.quiz) return describePoll(content.quiz, true);
  if (content?.poll) return describePoll(content.poll, false);
  return content?.text ?? '';
}

/** What would be posted next (does not modify anything). */
export function previewNext(cfg, targetKey = '') {
  const pool = loadPool(cfg, targetKey);
  const total = pool.queue.length;
  // Preview must match the mix: with 10 Maths + 10 Reasoning, the first post is
  // a Maths question, not whatever happens to come first in the whole bank.
  const { questions } = pickCandidates(pool, cfg);
  const q = questions[0];

  if (!q) return { finished: true, total, covered: pool.covered };

  // A run always numbers its questions from 1, so the next one is "Q1".
  const number = 1;
  const ctx = useContext(q, cfg, number);
  const style = postStyle(cfg);

  return {
    finished: false,
    question: q,
    number,
    total,
    covered: pool.covered,
    mode: style,
    poll: style === 'poll' ? buildPoll(q, ctx) : null,
    quiz: style === 'quiz' ? buildQuiz(q, ctx) : null,
    correctLetter: correctLetterOf(q, ctx.order),
    questionText: buildQuestionPost(q, ctx),
    answerText: buildAnswerPost(q, ctx),
  };
}

/**
 * Posts a batch of questions with a delay between each.
 *
 * The first message (intro) and the last one (score poll) are the two that make
 * a run look complete, so they are sent with `phase: 'intro' | 'summary'` and
 * the caller retries those harder.
 *
 * A single failed question no longer kills the run: it is counted, the run
 * carries on, and the closing summary still goes out.
 *
 * @param send        async (content, { phase }) => void
 * @param onEvent     receives { type: 'batchStart'|'intro'|'sent'|'postFailed'|'summary'|'summaryFailed'|'batchEnd', ... }
 * @param shouldStop  () => boolean — cooperative cancel
 * @param commit      false = do not record progress (dry runs)
 */
export async function runBatch({
  cfg,
  targetKey = '',
  send,
  onEvent = () => {},
  shouldStop = () => false,
  commit = true,
}) {
  const pool = loadPool(cfg, targetKey);
  const target = pool.target;
  const total = pool.queue.length;
  const startedAt = Date.now();
  const quotas = cfg.selection?.quotas ?? [];

  let plan = pickCandidates(pool, cfg);

  if (plan.questions.length === 0 && cfg.resetWhenFinished) {
    target.postedIds = [];
    pool.posted = new Set();
    if (commit) saveState(pool.state);
    plan = pickCandidates(pool, cfg);
  }

  if (plan.questions.length === 0) {
    return {
      finished: true,
      sent: 0,
      failed: 0,
      stopped: false,
      total,
      covered: pool.covered,
      ms: 0,
      composition: plan.composition,
    };
  }

  const { size, gapSeconds, introMessage } = cfg.batch;
  // A mix defines its own run length (10 + 10 + 10 = 30 questions). `size` is
  // only used when there is no mix, so a stale "50" cannot cut a preset short.
  const batch = quotas.length ? plan.questions : plan.questions.slice(0, size);

  onEvent({
    type: 'batchStart',
    planned: batch.length,
    total,
    covered: pool.covered,
    targetKey,
    composition: plan.composition,
  });

  // Remember which questions this run contains, in order. The repost box uses
  // it to turn "Q40" back into the right question even though 40 is not a bank
  // position (runs are numbered 1..N every time).
  if (commit && batch.length) {
    target.run = { at: new Date().toISOString(), ids: batch.map((q) => q.id) };
    saveState(pool.state);
  }

  // FIRST MESSAGE — retried hard by the caller; if it cannot be sent we stop
  // before posting 50 questions with no header.
  if (introMessage && batch.length && !shouldStop()) {
    const intro = buildBatchIntro({ count: batch.length, cfg });
    await send({ text: intro }, { phase: 'intro' });
    onEvent({ type: 'intro', text: intro });
  }

  const moduleCounts = new Map();
  const unconfirmedPositions = [];
  let sent = 0;
  let failed = 0;
  let stopped = false;
  let consecutiveFailures = 0;

  for (const [i, q] of batch.entries()) {
    if (shouldStop()) {
      stopped = true;
      break;
    }

    // Number printed in the post: 1..N for this run, not the bank position.
    const number = i + 1;
    const ctx = useContext(q, cfg, number);
    const contents = buildContents(q, ctx);

    try {
      // false = written to the socket but never acknowledged by WhatsApp, so it
      // may be missing from the channel. Still counted as sent (it might have
      // landed) but reported so it can be reposted.
      let confirmed = true;
      for (const content of contents) {
        const result = await send(content, { phase: 'question' });
        if (result === false) confirmed = false;
      }

      if (commit) {
        if (!target.postedIds.includes(q.id)) target.postedIds.push(q.id);
        target.history.push({ id: q.id, at: new Date().toISOString() });
        saveState(pool.state); // saved per post so an interruption never repeats a question
      }

      moduleCounts.set(q.module, (moduleCounts.get(q.module) ?? 0) + 1);
      sent += 1;
      consecutiveFailures = 0;
      if (!confirmed) unconfirmedPositions.push(number);
      onEvent({
        type: 'sent',
        index: number,
        planned: batch.length,
        module: q.module,
        number,
        total,
        unconfirmed: !confirmed,
        text: describeContent(contents[0]),
      });
    } catch (err) {
      failed += 1;
      consecutiveFailures += 1;
      onEvent({
        type: 'postFailed',
        index: number,
        planned: batch.length,
        number,
        module: q.module,
        message: err.message,
      });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        onEvent({ type: 'postFailedStop', message: `${consecutiveFailures} questions failed in a row — stopping.` });
        stopped = true;
        break;
      }
    }

    if (i < batch.length - 1 && !shouldStop()) {
      // Slight jitter on the gap: a perfectly even rhythm is the easiest
      // pattern for spam detection to spot. The average gap is unchanged.
      const jitter = gapSeconds > 0 ? 0.85 + Math.random() * 0.3 : 1;
      await pause(gapSeconds * 1000 * jitter);
    }
  }

  const postedNow = new Set(target.postedIds);
  const coveredNow = pool.queue.reduce((n, q) => n + (postedNow.has(q.id) ? 1 : 0), 0);

  let summary = null;
  let summaryError = null;
  if (sent > 0) {
    // LAST MESSAGE — a score poll by default. Sent even when some questions
    // failed, so the run always closes properly.
    const content = buildSummaryContent({
      count: sent,
      moduleCounts,
      covered: coveredNow,
      total,
      cfg,
    });
    try {
      await send(content, { phase: 'summary' });
      summary = describeContent(content);
      onEvent({ type: 'summary', text: summary, mode: content.poll ? 'poll' : 'text' });
    } catch (err) {
      summaryError = err.message;
      onEvent({ type: 'summaryFailed', message: err.message });
    }
  }

  const result = {
    sent,
    failed,
    total,
    covered: coveredNow,
    stopped,
    finished: false,
    targetKey,
    summaryError,
    unconfirmed: unconfirmedPositions,
    composition: plan.composition,
    ms: Date.now() - startedAt,
  };
  onEvent({ type: 'batchEnd', ...result });
  return result;
}
