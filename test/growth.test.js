import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blankGrowth,
  ensureGrowth,
  inviteCode,
  isAllowed,
  isBlocked,
  joinGate,
  nextShare,
  normalizeGrowthSettings,
  rollGrowthDay,
  shareText,
} from '../src/growth.js';

const settings = (over = {}) => normalizeGrowthSettings({
  enabled: true,
  channelLink: 'https://whatsapp.com/channel/0029Vabc',
  ...over,
});

test('invite links and bare codes both resolve to a code', () => {
  assert.equal(inviteCode('https://chat.whatsapp.com/AbCdEf123456'), 'AbCdEf123456');
  assert.equal(inviteCode('chat.whatsapp.com/invite/AbCdEf123456'), 'AbCdEf123456');
  assert.equal(inviteCode('AbCdEf123456'), 'AbCdEf123456');
  assert.equal(inviteCode('https://example.com/not-a-group'), '');
  assert.equal(inviteCode(''), '');
});

test('settings default to dry run and clamp the caps', () => {
  const s = normalizeGrowthSettings({
    enabled: true,
    joinPerDay: 99,
    maxGroups: 0,
    shareAfterHours: 999,
    dryRun: undefined,
  });
  assert.equal(s.dryRun, true);
  assert.equal(s.joinPerDay, 10);
  assert.equal(s.maxGroups, 1);
  assert.equal(s.shareAfterHours, 168);
  assert.equal(normalizeGrowthSettings({ dryRun: false }).dryRun, false);
});

test('the daily join counter resets on a new day', () => {
  const growth = blankGrowth();
  growth.day = '2026-11-02';
  growth.joinsToday = 3;
  rollGrowthDay(growth, '2026-11-03');
  assert.equal(growth.joinsToday, 0);
  assert.equal(growth.day, '2026-11-03');
});

test('joinGate enforces off, channel link, daily cap and gap', () => {
  const now = 1_000_000_000;
  const growth = blankGrowth();

  assert.equal(joinGate(growth, settings({ enabled: false }), now).ok, false);
  assert.equal(joinGate(growth, settings({ channelLink: '' }), now).ok, false);

  growth.joinsToday = 3;
  assert.equal(joinGate(growth, settings({ joinPerDay: 3 }), now).ok, false);

  growth.joinsToday = 0;
  growth.lastJoinAt = now - 10 * 60_000;
  const gate = joinGate(growth, settings({ joinGapMinutes: 60 }), now);
  assert.equal(gate.ok, false);
  assert.equal(gate.waitMs, 50 * 60_000);

  growth.lastJoinAt = now - 61 * 60_000;
  assert.equal(joinGate(growth, settings({ joinGapMinutes: 60 }), now).ok, true);
});

test('nextShare waits for the configured age and daily cap', () => {
  const now = 10_000_000_000;
  const growth = blankGrowth();
  growth.candidates = [
    { id: 'old', subject: 'Old', joinedAt: now - 30 * 3_600_000, status: 'joined' },
    { id: 'new', subject: 'New', joinedAt: now - 2 * 3_600_000, status: 'joined' },
    { id: 'gone', subject: 'Gone', joinedAt: now - 30 * 3_600_000, status: 'left' },
  ];

  assert.equal(nextShare(growth, settings({ shareAfterHours: 24 }), now).candidate.id, 'old');

  growth.sharesToday = 2;
  assert.equal(nextShare(growth, settings({ sharePerDay: 2 }), now).ok, false);

  growth.sharesToday = 0;
  growth.lastShareAt = now - 5 * 60_000;
  assert.equal(nextShare(growth, settings({ shareGapMinutes: 30 }), now).ok, false);
});

test('the share message fills in the link and group name', () => {
  const text = shareText(settings({ message: 'Hi {name}, join {link}' }), { subject: 'HSSC' });
  assert.equal(text, 'Hi HSSC, join https://whatsapp.com/channel/0029Vabc');
});

test('blocked words and the allowlist are both enforced', () => {
  const s = settings({ blocked: ['casino'], allowlist: ['https://chat.whatsapp.com/AbCdEf123456'] });
  assert.equal(isBlocked(s, 'HSSC Casino Deals'), true);
  assert.equal(isBlocked(s, 'HSSC Exam Group'), false);
  assert.equal(isAllowed(s, { code: 'AbCdEf123456' }), true);
  assert.equal(isAllowed(s, { code: 'ZZZZZZZZZZZZ' }), false);
  assert.equal(isAllowed(settings(), { code: 'anything' }), true);
});

test('ensureGrowth repairs a partial state file', () => {
  const state = { growth: { candidates: 'nope', joinsToday: '2' } };
  const growth = ensureGrowth(state);
  assert.deepEqual(growth.candidates, []);
  assert.equal(growth.joinsToday, 2);
  assert.equal(growth.lastJoinAt, 0);
});
