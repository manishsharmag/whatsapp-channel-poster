import test from 'node:test';
import assert from 'node:assert/strict';
import { proto } from '@whiskeysockets/baileys';
import { buildQuestionPost, buildPoll, buildAnswerPost } from '../src/format.js';
import { parseMessageUpdates, filterMessages } from '../src/forward.js';

const cfg = {
  language: 'en',
  headerEmoji: '📘',
  answerEmoji: '✅',
  showModuleTag: true,
  showQuestionNumber: true,
  showSubtopic: false,
  showExplanation: true,
  mode: 'quiz',
  replyPrompt: 'Reply below',
  hashtags: ['#HSSC'],
  batch: {},
};

const question = {
  id: 'q1',
  module: 'Polity',
  subtopic: '',
  question: { en: 'Who wrote the Constitution?', hi: '' },
  options: [{ en: 'A' }, { en: 'B' }, { en: 'C' }, { en: 'D' }],
  correctIndex: 0,
  explanation: { en: 'It was the Constituent Assembly.', hi: '' },
};

const order = [0, 1, 2, 3];

test('question number is the run number, not the bank size', () => {
  const text = buildQuestionPost(question, { cfg, number: 7, order });
  assert.match(text, /Q7/);
  assert.doesNotMatch(text, /4688/);
});

test('a total is only shown when a caller explicitly passes one', () => {
  const text = buildAnswerPost(question, { cfg, number: 7, total: 50, order });
  assert.match(text, /Q7\/50/);
});

test('poll header uses the run number and no total', () => {
  const poll = buildPoll(question, { cfg, number: 3, order });
  assert.ok(poll.name.startsWith('Q3 · Polity'));
  assert.ok(!poll.name.includes('/'));
});

test('parseMessageUpdates reads plaintext channel messages', () => {
  const node = {
    tag: 'iq',
    attrs: {},
    content: [{
      tag: 'message_updates',
      attrs: {},
      content: [
        {
          tag: 'message',
          attrs: { message_id: 'm1', t: '1750000000' },
          content: [{ tag: 'plaintext', content: proto.Message.encode({ conversation: 'HSSC result out' }).finish() }],
        },
        {
          tag: 'message',
          attrs: { message_id: 'm2', t: '1750000100' },
          content: [{ tag: 'plaintext', content: proto.Message.encode({ imageMessage: { caption: 'Ad: join now' } }).finish() }],
        },
      ],
    }],
  };

  const messages = parseMessageUpdates(node);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, 'HSSC result out');
  assert.equal(messages[1].text, 'Ad: join now');
});

test('keyword allow and block lists filter forwarded news', () => {
  const messages = [
    { id: '1', text: 'HSSC result out' },
    { id: '2', text: 'Advertisement: join our group' },
    { id: '3', text: 'Weather update' },
  ];
  assert.deepEqual(
    filterMessages(messages, { keywords: ['hssc'] }).map((m) => m.id),
    ['1'],
  );
  assert.deepEqual(
    filterMessages(messages, { blocked: ['advertisement'] }).map((m) => m.id),
    ['1', '3'],
  );
  assert.equal(filterMessages(messages, {}).length, 3);
});
