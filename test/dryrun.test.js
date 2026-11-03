import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { loadPool, runBatch, previewNext } from '../src/batch.js';
import { buildQuestionPost, buildQuiz, buildSummaryPoll, scoreBandsFor, optionOrder } from '../src/format.js';
import { searchExaNews, formatNewsBulletin, processExaNews } from '../src/news.js';
import {
  ensureGrowth,
  joinGate,
  shareText,
  normalizeGrowthSettings,
  inviteCode,
} from '../src/growth.js';
import { checkPassword, createSessionToken, verifySessionToken } from '../src/gui/auth.js';

test('END-TO-END DRY RUN: 1. Question pool and selection', () => {
  const cfg = loadConfig();
  const pool = loadPool(cfg, 'dryrun-target');
  assert.ok(pool.queue.length > 4000, `Pool loaded ${pool.queue.length} usable questions`);

  const preview = previewNext(cfg, 'dryrun-target');
  assert.equal(preview.number, 1, 'First question number is 1');
  assert.ok(preview.question, 'Question object is present');

  const order = optionOrder(preview.question, false);
  const qText = buildQuestionPost(preview.question, { cfg, number: 1, total: 50, order });
  assert.ok(qText.includes('Q1/50') || qText.includes('Q1'));
  assert.ok(!qText.includes('Q4688'));

  const quiz = buildQuiz(preview.question, { cfg, number: 1, total: null, order });
  assert.ok(quiz.name.startsWith('Q1'), 'Quiz title starts with Q1');
  assert.ok(quiz.values.length >= 2 && quiz.values.length <= 4);
  assert.ok(typeof quiz.correctIndex === 'number' && quiz.correctIndex >= 0);

  const bands = scoreBandsFor(50);
  assert.ok(bands.length <= 12, 'Closing poll within WhatsApp limit');
  assert.equal(bands[0], '50/50 🏆');

  const summary = buildSummaryPoll({ count: 50, covered: 50, total: 4688, cfg });
  assert.ok(summary.name.includes('questions complete'));
});

test('END-TO-END DRY RUN: 2. Quota-based batch mock execution', async () => {
  const cfg = loadConfig();
  const quotaConfig = {
    ...cfg,
    selection: {
      modules: [],
      subtopics: [],
      mode: 'sequence',
      quotas: [
        { module: 'Quantitative Ability', count: 5 },
        { module: 'Reasoning Ability', count: 5 },
        { module: 'English Language & Grammar', count: 5 },
        { module: 'Hindi Language', count: 5 },
        { module: 'Haryana General Knowledge', count: 5 },
      ],
      quotaOrder: 'grouped',
    },
    batch: { size: 50, gapSeconds: 0, style: 'quiz' },
    dryRun: true,
  };

  const sent = [];
  const stubSender = (content) => {
    sent.push(content);
    return Promise.resolve({ id: `stub_${sent.length}` });
  };

  const res = await runBatch({
    cfg: quotaConfig,
    targetKey: 'wa:mock_channel@newsletter',
    send: stubSender,
    commit: false,
  });

  assert.equal(res.sent, 25, 'Batch sent exact quota sum of 25 questions');
  assert.equal(sent.length, 51, '25 questions (quiz + answer each) + 1 closing score poll');
  assert.ok(sent[0].quiz.name.startsWith('Q1'), 'First question is Q1');
  assert.ok(sent[48].quiz.name.startsWith('Q25'), '25th question is Q25');
  assert.ok(sent[50].poll.name.includes('questions complete'), 'Closing summary poll sent');
});

test('END-TO-END DRY RUN: 3. Exa News live query and formatting', async () => {
  const cfg = loadConfig();
  const articles = await searchExaNews('Haryana government job notifications', process.env.EXA_API_KEY);
  assert.ok(articles.length > 0, 'Exa returned live news articles');

  const sample = articles[0];
  assert.ok(sample.title && sample.url);
  assert.ok(Array.isArray(sample.highlights));

  const bulletin = formatNewsBulletin(sample);
  assert.ok(bulletin.includes('📢 *Govt Job & Exam Alert*'));
  assert.ok(bulletin.includes(sample.url));

  const dryResult = await processExaNews(cfg, null, { dryRun: true });
  assert.equal(dryResult.posted, 0, 'Dry run does not post to live socket');
});

test('END-TO-END DRY RUN: 4. Group growth gates and invite parser', () => {
  const code = inviteCode('https://chat.whatsapp.com/BPylBn01CV7IIcllYDj0A3');
  assert.equal(code, 'BPylBn01CV7IIcllYDj0A3');

  const settings = normalizeGrowthSettings({
    enabled: true,
    dryRun: true,
    channelLink: 'https://whatsapp.com/channel/0029VaTest',
  });

  const growth = ensureGrowth({});
  const check = joinGate(growth, settings);
  assert.equal(check.ok, true);

  const shareMsg = shareText(settings, { subject: 'Test Group' });
  assert.ok(shareMsg.includes(settings.channelLink));
});

test('END-TO-END DRY RUN: 5. Auth security verification', () => {
  const prev = process.env.PANEL_PASSWORD;
  try {
    process.env.PANEL_PASSWORD = 'super-secret-password-123';
    assert.equal(checkPassword('super-secret-password-123'), true);
    assert.equal(checkPassword('wrong'), false);

    const token = createSessionToken();
    assert.equal(verifySessionToken(token), true);

    process.env.PANEL_PASSWORD = 'changed-password-456';
    assert.equal(verifySessionToken(token), false);
  } finally {
    if (prev) process.env.PANEL_PASSWORD = prev;
    else delete process.env.PANEL_PASSWORD;
  }
});
