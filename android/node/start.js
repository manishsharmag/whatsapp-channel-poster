/**
 * Android entry point.
 *
 * nodejs-mobile gives us a normal Node runtime, so the poster itself is
 * unchanged: this file mirrors console output to a file the app can show, clears
 * a lock left by a previous process, then starts the same Control Panel the
 * desktop app uses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(here); // <files>/app
const logFile = path.join(appDir, 'node.log');

try {
  fs.writeFileSync(logFile, '');
} catch {
  // Not fatal: the app only loses the log view.
}

const write = (level, parts) => {
  const line = `[${level}] ${parts
    .map((p) => {
      if (typeof p === 'string') return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(' ')}`;
  try {
    fs.appendFileSync(logFile, `${line}\n`);
  } catch {
    // ignore
  }
};

const realLog = console.log.bind(console);
const realError = console.error.bind(console);
console.log = (...args) => {
  write('info', args);
  realLog(...args);
};
console.error = (...args) => {
  write('err', args);
  realError(...args);
};

process.on('uncaughtException', (err) => {
  write('err', ['uncaught:', err?.stack ?? String(err)]);
  // A half-dead event loop cannot keep posting reliably; let Android restart
  // the foreground service with a clean process instead.
  setTimeout(() => process.exit(1), 50);
});
process.on('unhandledRejection', (err) => {
  write('err', ['unhandled rejection:', err?.stack ?? String(err)]);
});

console.log(`Android start — ${process.version} (${process.platform}/${process.arch})`);
console.log(`App folder: ${appDir}`);

// nodejs-mobile ships Node built without ICU: TextDecoder still decodes UTF-8
// but rejects { fatal: true }, which whatsapp-rust-bridge passes while reading
// strings out of WebAssembly memory. Accept the option instead of crashing.
try {
  new TextDecoder('utf-8', { fatal: true });
} catch {
  const NativeTextDecoder = globalThis.TextDecoder;
  globalThis.TextDecoder = class TolerantTextDecoder {
    constructor(label = 'utf-8', options = {}) {
      this.encoding = String(label).toLowerCase();
      this.fatal = !!options.fatal;
      this.ignoreBOM = !!options.ignoreBOM;
    }

    decode(input) {
      if (input == null) return '';
      const bytes = input instanceof Uint8Array
        ? input
        : new Uint8Array(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength);
      const out = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
      return this.ignoreBOM ? out : out.replace(/^\uFEFF/, '');
    }
  };
  // Keep the native class reachable for anything that checks its identity.
  globalThis.TextDecoder.Native = NativeTextDecoder;
  console.log('Installed the TextDecoder compatibility shim (Node without ICU).');
}

// Only one poster may own the WhatsApp session. Android reuses PIDs, so a lock
// left by a killed process can point at a live PID that is not us — start clean.
const lockFile = path.join(appDir, 'state', 'app.lock');
try {
  if (fs.existsSync(lockFile)) {
    fs.rmSync(lockFile, { force: true });
    console.log('Cleared the previous app lock.');
  }
} catch (err) {
  console.log(`Could not clear the app lock: ${err.message}`);
}

// The panel is the WebView; opening an external browser would leave the app.
process.env.NO_BROWSER = 'true';
process.env.HOST ??= '127.0.0.1';
process.env.PORT ??= '8777';

try {
  // Imported after the console tee and the lock cleanup above, because
  // server.js starts listening and connecting as soon as it loads.
  await import('../src/gui/server.js');
} catch (err) {
  console.error(`Could not start the Control Panel: ${err?.stack ?? err}`);
  process.exit(1);
}
