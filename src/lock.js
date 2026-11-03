import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';

const LOCK_FILE = path.join(dataDir(), 'state', 'app.lock');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Only one program may use the WhatsApp session at a time.
 * Two processes sharing ./auth cause "Connection closed (440)" loops.
 */
export function acquireLock(mode = 'app') {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });

  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    existing = null;
  }

  if (existing?.pid && existing.pid !== process.pid && isAlive(existing.pid)) {
    throw new Error(
      'Another instance is already using the WhatsApp session\n' +
      `   Running: ${existing.mode} (PID ${existing.pid}, started ${existing.startedAt})\n\n` +
      '   Close that window first. Two programs cannot share one WhatsApp session —\n' +
      '   it causes the "Connection closed (440)" loop.'
    );
  }

  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, mode, startedAt: new Date().toISOString() }));

  const release = () => {
    try {
      const info = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (info.pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch {
      /* already gone */
    }
  };

  process.on('exit', release);
  process.on('SIGINT', () => {
    release();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    release();
    process.exit(0);
  });

  return release;
}
