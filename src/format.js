const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function hashString(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic shuffle seeded by question id: the same question always yields
 * the same option order, so a question posted at 8am and its answer posted at
 * 8pm always line up. Also fixes banks where the correct answer is always "A".
 */
export function optionOrder(question, shuffle) {
  const order = question.options.map((_, i) => i);
  if (!shuffle) return order;
  const rnd = mulberry32(hashString(question.id));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function optionText(option, lang) {
  if (lang === 'hi') return option.hi || option.en;
  if (lang === 'both') return option.hi && option.en && option.hi !== option.en ? `${option.en} / ${option.hi}` : option.en || option.hi;
  return option.en || option.hi;
}

function questionLines(question, lang) {
  const { en, hi } = question;
  if (lang === 'hi') return [hi || en];
  if (lang === 'both' && hi && hi !== en) return [en, hi];
  return [en || hi];
}

function explanationText(explanation, lang) {
  if (lang === 'hi') return explanation.hi || explanation.en;
  if (lang === 'both' && explanation.hi && explanation.hi !== explanation.en) {
    return `${explanation.en}${explanation.en && explanation.hi ? ' / ' : ''}${explanation.hi}`;
  }
  return explanation.en || explanation.hi;
}

function hashtagLine(cfg) {
  return cfg.hashtags?.length ? cfg.hashtags.join(' ') : '';
}

/**
 * "Q4" — the number of the question inside today's run, never the size of the
 * whole bank. `total` is only used by older callers that still show "Q4/50".
 */
function questionNumber({ number, total }) {
  if (!number) return '';
  return total ? `Q${number}/${total}` : `Q${number}`;
}

export function buildQuestionPost(q, { cfg, number, total, order }) {
  const lines = [];
  const lang = cfg.language;

  if (cfg.showModuleTag) lines.push(`${cfg.headerEmoji} *${q.module}*`);

  const meta = [];
  if (cfg.showSubtopic && q.subtopic) meta.push(q.subtopic);
  if (cfg.showQuestionNumber) meta.push(questionNumber({ number, total }));
  if (meta.length) lines.push(`_${meta.join(' • ')}_`);

  lines.push('');
  const qLines = questionLines(q.question, lang);
  lines.push(`*Q. ${qLines[0]}*`);
  for (const extra of qLines.slice(1)) lines.push(`*${extra}*`);
  lines.push('');

  order.forEach((optionIndex, displayIndex) => {
    lines.push(`${LETTERS[displayIndex]}) ${optionText(q.options[optionIndex], lang)}`);
  });

  lines.push('');
  if (cfg.mode === 'quiz') lines.push(cfg.replyPrompt);

  const tags = hashtagLine(cfg);
  if (tags) lines.push(tags);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildAnswerPost(q, { cfg, number, total, order, pollResults }) {
  const lang = cfg.language;
  const correctLetter = LETTERS[order.indexOf(q.correctIndex)];
  const lines = [`*Answer: ${correctLetter}) ${optionText(q.options[q.correctIndex], lang)}* ${cfg.answerEmoji}`];

  if (pollResults && pollResults.totalVotes > 0) {
    const right = pollResults.correctVotes ?? 0;
    const wrong = pollResults.wrongVotes ?? 0;
    const total = pollResults.totalVotes;
    const rightPct = Math.round((right / total) * 100);
    const wrongPct = Math.round((wrong / total) * 100);
    lines.push('', `📊 *Subscriber Results:*`);
    lines.push(`✅ Correct: *${rightPct}%* (${right} user${right === 1 ? '' : 's'})`);
    lines.push(`❌ Incorrect: *${wrongPct}%* (${wrong} user${wrong === 1 ? '' : 's'})`);
  }

  const explanation = cfg.showExplanation ? explanationText(q.explanation, lang) : '';
  if (explanation) lines.push('', `💡 ${explanation}`);

  const meta = [];
  if (cfg.showModuleTag) meta.push(q.module);
  if (cfg.showQuestionNumber) meta.push(questionNumber({ number, total }));

  lines.push('');
  if (meta.length) lines.push(meta.join(' | '));
  const tags = hashtagLine(cfg);
  if (tags) lines.push(tags);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildFullPost(q, ctx) {
  return `${buildQuestionPost(q, ctx)}\n\n${buildAnswerPost(q, ctx)}`;
}

// ---- quiz poll (native WhatsApp poll with tap-to-answer radio buttons) ----

const POLL_NAME_MAX = 255;
const POLL_OPTION_MAX = 100;

function truncate(text, max) {
  const s = String(text).trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export function buildPoll(q, { cfg, number, total, order }) {
  const lang = cfg.language;
  const head = [];
  if (cfg.showQuestionNumber) {
    const label = questionNumber({ number, total });
    if (label) head.push(label);
  }
  if (cfg.showModuleTag) head.push(q.module);

  const body = questionLines(q.question, lang).join('\n');
  const name = truncate(`${head.length ? `${head.join(' · ')}\n\n` : ''}${body}`, POLL_NAME_MAX);

  const values = order.map((optionIndex, displayIndex) =>
    truncate(`${LETTERS[displayIndex]}) ${optionText(q.options[optionIndex], lang)}`, POLL_OPTION_MAX),
  );

  return { name, values, selectableCount: 1 };
}

/**
 * WhatsApp "Quiz": same shape as a poll, but one option is flagged as the
 * correct answer, so a subscriber gets an instant tick/cross when they tap.
 * `correctIndex` is the position of the right answer *after* shuffling.
 */
export function buildQuiz(q, ctx) {
  const { name, values } = buildPoll(q, ctx);
  const explanation = ctx.cfg.showExplanation ? explanationText(q.explanation, ctx.cfg.language) : '';
  return {
    name,
    values,
    correctIndex: ctx.order.indexOf(q.correctIndex),
    // Telegram quizzes show this after the answer; WhatsApp ignores it.
    explanation: explanation ?? '',
  };
}

export function correctLetterOf(q, order) {
  return LETTERS[order.indexOf(q.correctIndex)];
}

export function buildBatchIntro({ count, cfg }) {
  const lines = [`${cfg.headerEmoji} *Daily Quiz — ${count} Questions*`];
  lines.push('');
  const style = cfg.batch.style ?? 'text';
  if (style === 'quiz') {
    lines.push(`The quiz has started! 📝 There are ${count} questions.`);
    lines.push('Tap the option you think is correct — you will see straight away whether you got it right. ✅');
  } else if (style === 'poll') {
    lines.push(`Poll time! 📊 There are ${count} questions.`);
    lines.push(cfg.batch.includeAnswer
      ? 'Each answer is posted right after its question.'
      : 'Answers will follow in the next post.');
  } else if (cfg.batch.includeAnswer) {
    lines.push("Let's begin! The answer is given after each question.");
  } else {
    lines.push("Let's begin! Answers will follow in the next post.");
  }
  lines.push('', 'Read carefully and keep your score. 📝');
  const tags = hashtagLine(cfg);
  if (tags) lines.push('', tags);
  return lines.join('\n').trim();
}

export function buildBatchSummary({ count, moduleCounts, covered, total, cfg }) {
  const lines = [`${cfg.headerEmoji} *Aaj ke ${count} questions complete!* ✅`];
  lines.push('');

  const breakdown = [...moduleCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (breakdown.length) {
    lines.push('*Topics covered today:*');
    for (const [module, n] of breakdown) lines.push(`• ${module} — ${n}`);
    lines.push('');
  }

  lines.push(`📊 *Questions completed so far: ${covered}/${total}*`);
  lines.push('');
  lines.push(cfg.batch.scorePrompt);

  const tags = hashtagLine(cfg);
  if (tags) lines.push('', tags);
  return lines.join('\n').trim();
}

// ---- end-of-batch score poll ----
//
// A channel has no replies, so a plain text "what's your score?" gets nothing
// back. Sending the summary as a poll gives subscribers a tap-to-respond button
// instead — and the votes can be read later.

const DEFAULTS_SCORE_PROMPT = "❓ *What's your score?* Tap the band you got 👇";

/**
 * Score bands for the summary poll, scaled to the batch size.
 * 50 questions -> 50/50 🏆, 40–49, 30–39, 20–29, 10–19, Below 10.
 */
export function scoreBandsFor(count) {
  const n = Math.max(1, Math.floor(count));
  let step = n <= 10 ? 2 : n <= 20 ? 5 : 10;
  // WhatsApp allows at most 12 options, so widen the bands if needed.
  while (Math.floor((n - 1) / step) + 2 > 12) step += 5;
  const bands = [`${n}/${n} 🏆`];
  let high = n - 1;
  while (high >= step) {
    const low = high - step + 1;
    bands.push(`${low}–${high}`);
    high = low - 1;
  }
  bands.push(high >= 1 ? `Below ${high + 1}` : 'None right');
  return bands;
}

export function buildSummaryPoll({ count, moduleCounts, covered, total, cfg }) {
  const bands = cfg.batch.scoreBands?.length ? cfg.batch.scoreBands : scoreBandsFor(count);
  const values = bands.map((band) => truncate(band, POLL_OPTION_MAX));

  const head = `${cfg.headerEmoji} *Aaj ke ${count} questions complete!* ✅`;
  const progress = `📊 Completed so far: ${covered}/${total}`;
  const prompt = cfg.batch.scorePollPrompt || DEFAULTS_SCORE_PROMPT;

  const breakdown = [...(moduleCounts ?? new Map()).entries()].sort((a, b) => b[1] - a[1]);
  const topics = breakdown.length
    ? `📚 ${breakdown.map(([module, n]) => `${module} (${n})`).join(' · ')}`
    : '';

  // Keep the topic list when it fits; a 255-char poll question cannot always
  // hold it, and the progress line plus the prompt matter more.
  const build = (withTopics) => [
    head,
    ...(withTopics && topics ? ['', topics] : []),
    '',
    progress,
    '',
    prompt,
  ].join('\n');

  let name = build(true);
  if (name.length > POLL_NAME_MAX) name = build(false);

  return { name: truncate(name, POLL_NAME_MAX), values, selectableCount: 1 };
}

/** The end-of-batch message: a tap-to-respond score poll, or plain text. */
export function buildSummaryContent(args) {
  if (args.cfg.batch.scorePoll === false) return { text: buildBatchSummary(args) };
  return { poll: buildSummaryPoll(args) };
}
