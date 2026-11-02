import test from 'node:test';
import assert from 'node:assert/strict';
import { pickWithQuotas } from '../src/batch.js';

/** A tiny stand-in for a bank queue: 4 maths, 3 reasoning, 2 english. */
const bank = [
  ...Array.from({ length: 4 }, (_, i) => ({ id: `m${i + 1}`, module: 'Maths' })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `r${i + 1}`, module: 'Reasoning' })),
  ...Array.from({ length: 2 }, (_, i) => ({ id: `e${i + 1}`, module: 'English' })),
];

const quotas = [
  { module: 'Maths', count: 2 },
  { module: 'Reasoning', count: 2 },
  { module: 'English', count: 1 },
];

test('quotas pick the requested number per module, in order', () => {
  const { questions, composition } = pickWithQuotas(bank, quotas, { order: 'grouped' });

  assert.equal(questions.length, 5);
  assert.deepEqual(questions.map((q) => q.module), ['Maths', 'Maths', 'Reasoning', 'Reasoning', 'English']);
  assert.deepEqual(composition, [
    { module: 'Maths', requested: 2, picked: 2 },
    { module: 'Reasoning', requested: 2, picked: 2 },
    { module: 'English', requested: 1, picked: 1 },
  ]);
});

test('mixed order cycles through the subjects', () => {
  const { questions } = pickWithQuotas(bank, quotas, { order: 'mixed' });
  assert.deepEqual(questions.map((q) => q.module), ['Maths', 'Reasoning', 'English', 'Maths', 'Reasoning']);
});

test('a quota larger than the bank reports the shortfall without borrowing', () => {
  const { questions, composition } = pickWithQuotas(bank, [
    { module: 'Maths', count: 10 },
    { module: 'Reasoning', count: 1 },
  ], { order: 'grouped' });

  assert.equal(questions.length, 5); // 4 maths + 1 reasoning
  assert.deepEqual(composition, [
    { module: 'Maths', requested: 10, picked: 4 },
    { module: 'Reasoning', requested: 1, picked: 1 },
  ]);
});

test('the same question is never picked twice', () => {
  const { questions } = pickWithQuotas(bank, [
    { module: 'Maths', count: 3 },
    { module: 'Maths', count: 3 },
  ]);
  const ids = questions.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('unknown modules are simply empty', () => {
  const { questions, composition } = pickWithQuotas(bank, [{ module: 'Physics', count: 5 }]);
  assert.equal(questions.length, 0);
  assert.equal(composition[0].picked, 0);
});

test('random mode keeps the exact counts, only the order changes', () => {
  const { questions } = pickWithQuotas(bank, [
    { module: 'Maths', count: 4 },
    { module: 'Reasoning', count: 2 },
  ], { random: true, order: 'grouped' });

  assert.equal(questions.length, 6);
  assert.equal(questions.filter((q) => q.module === 'Maths').length, 4);
  assert.equal(questions.filter((q) => q.module === 'Reasoning').length, 2);
});
