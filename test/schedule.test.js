import test from 'node:test';
import assert from 'node:assert/strict';
import { nextScheduleAt, dueSlot, slotKey, describeSchedule } from '../src/schedule.js';

// Local dates: 2 Nov 2026 is a Monday.
const monday0700 = () => new Date(2026, 10, 2, 7, 0, 0, 0);
const monday0900 = () => new Date(2026, 10, 2, 9, 0, 0, 0);

test('a disabled schedule never fires', () => {
  assert.equal(nextScheduleAt({ enabled: false, times: ['08:00'] }, monday0700()), 0);
  assert.equal(dueSlot({ enabled: false, times: ['08:00'] }, monday0700()), null);
});

test('the next slot is later the same day', () => {
  const at = nextScheduleAt({ enabled: true, times: ['08:00', '20:00'] }, monday0700());
  assert.equal(slotKey(new Date(at)), '2026-11-02 08:00');
});

test('a passed time rolls to tomorrow', () => {
  const at = nextScheduleAt({ enabled: true, times: ['08:00'] }, monday0900());
  assert.equal(slotKey(new Date(at)), '2026-11-03 08:00');
});

test('weekday filter skips days that are switched off', () => {
  // Only Sunday selected: Monday 09:00 must wait until 8 Nov.
  const at = nextScheduleAt({ enabled: true, times: ['08:00'], weekdays: [0] }, monday0900());
  assert.equal(slotKey(new Date(at)), '2026-11-08 08:00');
});

test('dueSlot matches one exact minute and its day', () => {
  const schedule = { enabled: true, times: ['08:00', '20:00'] };
  assert.equal(dueSlot(schedule, new Date(2026, 10, 2, 8, 0)), '2026-11-02 08:00');
  assert.equal(dueSlot(schedule, new Date(2026, 10, 2, 8, 1)), null);
  assert.equal(dueSlot({ ...schedule, weekdays: [0] }, new Date(2026, 10, 2, 8, 0)), null);
});

test('the description reads like the panel sentence', () => {
  assert.equal(describeSchedule({ times: ['08:00', '20:00'] }), 'every day at 08:00, 20:00');
  assert.equal(describeSchedule({ times: ['08:00'], weekdays: [1, 3] }), 'Mon, Wed at 08:00');
});
