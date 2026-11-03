import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authRequired,
  checkPassword,
  createLoginThrottle,
  createSessionToken,
  parseCookies,
  verifySessionToken,
} from '../src/gui/auth.js';

function withPassword(password, fn) {
  const before = process.env.PANEL_PASSWORD;
  if (password == null) delete process.env.PANEL_PASSWORD;
  else process.env.PANEL_PASSWORD = password;
  try {
    return fn();
  } finally {
    if (before == null) delete process.env.PANEL_PASSWORD;
    else process.env.PANEL_PASSWORD = before;
  }
}

test('without PANEL_PASSWORD the panel is open', () => {
  withPassword(null, () => {
    assert.equal(authRequired(), false);
    assert.equal(checkPassword('anything'), true);
    assert.equal(verifySessionToken('whatever'), false);
  });
});

test('the password is compared exactly', () => {
  withPassword('s3cret-pass', () => {
    assert.equal(authRequired(), true);
    assert.equal(checkPassword('s3cret-pass'), true);
    assert.equal(checkPassword('s3cret'), false);
    assert.equal(checkPassword(''), false);
  });
});

test('a session token validates and expires', () => {
  withPassword('s3cret-pass', () => {
    const now = Date.now();
    const token = createSessionToken(now);
    assert.equal(verifySessionToken(token, now), true);
    assert.equal(verifySessionToken(token, now + 8 * 24 * 60 * 60 * 1000), false);
    assert.equal(verifySessionToken(`${token}x`, now), false);
    assert.equal(verifySessionToken('nonsense', now), false);
  });
});

test('changing the password signs every session out', () => {
  const token = withPassword('first-pass', () => createSessionToken());
  withPassword('second-pass', () => {
    assert.equal(verifySessionToken(token), false);
  });
});

test('cookies are parsed without breaking on = inside the value', () => {
  const cookies = parseCookies('a=1; panel_session=abc%3Ddef; empty=');
  assert.equal(cookies.a, '1');
  assert.equal(cookies.panel_session, 'abc=def');
  assert.equal(cookies.empty, '');
});

test('login throttle locks after the limit and resets', () => {
  const throttle = createLoginThrottle({ max: 2, windowMs: 60_000 });
  const now = 1_000_000;
  assert.equal(throttle.retryAfter('1.2.3.4', now), 0);
  throttle.fail('1.2.3.4', now);
  assert.equal(throttle.retryAfter('1.2.3.4', now), 0);
  throttle.fail('1.2.3.4', now);
  assert.ok(throttle.retryAfter('1.2.3.4', now) > 0);
  assert.equal(throttle.retryAfter('5.6.7.8', now), 0);
  throttle.reset('1.2.3.4');
  assert.equal(throttle.retryAfter('1.2.3.4', now), 0);
  assert.ok(throttle.retryAfter('1.2.3.4', now + 61_000) === 0);
});
