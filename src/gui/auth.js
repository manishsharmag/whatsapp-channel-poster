import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Optional password protection for the control panel.
 *
 * The panel used to be reachable from any browser on the network (and, on a
 * cloud host, from the whole internet). Set PANEL_PASSWORD to require a login;
 * leave it unset for the local-only desktop panel.
 *
 * The cookie is a signed, expiring token. The signing key is the password
 * itself, so changing the password logs every session out automatically.
 */

export const SESSION_COOKIE = 'panel_session';

/** How long a login lasts. */
const SESSION_DAYS = 7;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;

export function authRequired() {
  return Boolean(String(process.env.PANEL_PASSWORD ?? ''));
}

function key() {
  return String(process.env.PANEL_PASSWORD ?? '');
}

function sign(expiry) {
  return createHmac('sha256', key()).update(`panel-session:${expiry}`).digest('base64url');
}

export function createSessionToken(now = Date.now()) {
  const expiry = Math.floor(now / 1000) + SESSION_SECONDS;
  return `${expiry}.${sign(expiry)}`;
}

export function verifySessionToken(token, now = Date.now()) {
  if (!authRequired() || !token) return false;
  const [expiryRaw, signature] = String(token).split('.');
  const expiry = Number(expiryRaw);
  if (!Number.isFinite(expiry) || expiry * 1000 <= now) return false;

  const expected = Buffer.from(sign(expiryRaw));
  const actual = Buffer.from(signature ?? '');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Constant-time password check (the length check is unavoidable). */
export function checkPassword(input) {
  const expected = key();
  if (!expected) return true;
  const a = Buffer.from(String(input ?? ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

/**
 * `Secure` is only added when the request really arrived over HTTPS. Locally
 * the panel is plain HTTP, and a Secure cookie would never be sent back.
 */
export function sessionCookie(token, { secure = false } = {}) {
  const flags = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_SECONDS}`,
  ];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

export function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** True when the connection reached us over HTTPS (directly or via a proxy). */
export function isSecureRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  if (proto) return proto === 'https';
  return Boolean(req.socket?.encrypted);
}

/**
 * Very small in-memory throttle: N failed logins per IP per window, then a
 * short lockout. A restart clears it, which is fine for a single-user panel.
 */
export function createLoginThrottle({ max = 6, windowMs = 10 * 60 * 1000 } = {}) {
  const attempts = new Map();

  function entry(ip, now) {
    const found = attempts.get(ip);
    if (!found || now - found.first > windowMs) {
      const fresh = { count: 0, first: now };
      attempts.set(ip, fresh);
      return fresh;
    }
    return found;
  }

  return {
    /** Milliseconds until another try is allowed (0 = allowed now). */
    retryAfter(ip, now = Date.now()) {
      const found = entry(ip, now);
      if (found.count < max) return 0;
      return Math.max(0, windowMs - (now - found.first));
    },
    fail(ip, now = Date.now()) {
      entry(ip, now).count += 1;
    },
    reset(ip) {
      attempts.delete(ip);
    },
    /** Trim old IPs so the map cannot grow forever. */
    prune(now = Date.now()) {
      for (const [ip, found] of attempts) {
        if (now - found.first > windowMs) attempts.delete(ip);
      }
    },
  };
}
