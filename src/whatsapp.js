import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  proto,
  generateWAMessage,
  encodeNewsletterMessage,
  isJidNewsletter,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectRoot } from './config.js';

const logger = pino({ level: 'silent' });

export function authDir() {
  return path.join(projectRoot(), 'auth');
}

// ---------------------------------------------------------------------------
// Delivery confirmation
//
// Baileys does not wait for anything when a stanza is written: `sendNode`
// resolves as soon as the frame reaches the socket. If the connection dies
// right after that write, the message never reaches WhatsApp but the send still
// "succeeds" — which is how a question can be silently missing from a channel.
//
// WhatsApp ACKs every message stanza. Baileys forwards raw nodes as
// "CB:<tag>" events on the websocket, so listening for "CB:ack" tells us
// whether the server actually accepted the message.
// ---------------------------------------------------------------------------

const trackers = new WeakMap();
const ACK_TIMEOUT_MS = 15000;

export function attachAckTracker(sock) {
  const pending = new Map();
  // Acks can arrive before we get around to waiting for them, so keep a short
  // history of every id we have seen accepted.
  const seen = new Map();
  let sawAnyAck = false;

  const onAck = (frame) => {
    const attrs = frame?.attrs ?? {};
    const id = attrs.id;
    if (!id) return;

    const error = attrs.error;
    if (!error) sawAnyAck = true;
    seen.set(id, Date.now());
    if (seen.size > 400) {
      const cutoff = Date.now() - 120000;
      for (const [key, at] of seen) if (at < cutoff) seen.delete(key);
    }

    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    if (error) {
      entry.reject(Object.assign(
        new Error(`WhatsApp rejected this message (ack error ${error}).`),
        { code: 'ACK_ERROR' },
      ));
    } else {
      entry.resolve(attrs.type ?? 'server');
    }
  };

  try {
    sock.ws?.on('CB:ack', onAck);
  } catch { /* older socket without raw node events */ }

  const tracker = {
    get sawAnyAck() {
      return sawAnyAck;
    },
    /** Resolves when WhatsApp acks this message id, rejects on a nack/timeout. */
    wait(id, timeoutMs = ACK_TIMEOUT_MS) {
      if (seen.has(id)) return Promise.resolve('acked');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error('WhatsApp did not acknowledge this message.'), { code: 'NO_ACK' }));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
      });
    },
    dispose() {
      try {
        sock.ws?.off('CB:ack', onAck);
      } catch { /* ignore */ }
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(Object.assign(new Error('Connection closed before WhatsApp acknowledged it.'), { code: 'NO_ACK' }));
      }
      pending.clear();
    },
  };

  trackers.set(sock, tracker);
  return tracker;
}

/** The ack tracker for a live socket, or null if this socket has none. */
export function ackTracker(sock) {
  return sock ? trackers.get(sock) ?? null : null;
}

/**
 * Connect to WhatsApp as a linked device.
 * - loginMethod "qr"      -> prints a QR code to scan
 * - loginMethod "pairing" -> prints an 8-digit pairing code (needs phoneNumber)
 */
export async function connectWhatsApp(cfg, { onOpen, onClose, onQR, onPairingCode, printQR = true } = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(authDir());

  const sock = makeWASocket({
    auth: state,
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  attachAckTracker(sock);

  sock.ev.on('creds.update', saveCreds);

  let pairingRequested = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      onQR?.(qr);
      const wantsPairing = cfg.loginMethod === 'pairing' && cfg.phoneNumber;
      if (wantsPairing && !pairingRequested) {
        pairingRequested = true;
        try {
          const phone = String(cfg.phoneNumber).replace(/\D/g, '');
          const code = await sock.requestPairingCode(phone);
          console.log(`\n📱 PAIRING CODE: ${code}`);
          console.log('   WhatsApp -> Linked Devices -> Link with phone number\n');
          onPairingCode?.(code, phone);
        } catch (err) {
          console.error(`Pairing code failed (${err.message}); showing QR instead.`);
          onPairingCode?.(null, phone, err.message);
          if (printQR) qrcode.generate(qr, { small: true });
        }
      } else if (!wantsPairing && printQR) {
        console.log('\n📷 Scan this QR with WhatsApp -> Linked Devices:\n');
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'open') {
      console.log(`✅ Connected as ${sock.user?.id ?? 'unknown'}`);
      onOpen?.(sock);
    }

    if (connection === 'close') {
      // Unblock anything still waiting for an ack on the dead socket.
      try {
        trackers.get(sock)?.dispose();
      } catch { /* ignore */ }
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(loggedOut
        ? '🚫 Logged out. Delete the auth/ folder and run `npm run login` again.'
        : `⚠️  Connection closed (code ${statusCode ?? '?'}). Reconnecting...`);
      onClose?.(statusCode, loggedOut);
    }
  });

  return sock;
}

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Build a poll or quiz message.
 *
 * A "quiz" is a single-select poll that also carries the correct option, so
 * WhatsApp marks it right/wrong as soon as somebody taps an answer.
 *
 * Baileys' built-in `poll` helper does not set `pollType`/`correctAnswer`, so
 * we generate the message normally and then patch the proto ourselves.
 */
async function buildPollMessage(sock, jid, spec, isQuiz) {
  const msg = await generateWAMessage(
    jid,
    { poll: { name: spec.name, values: spec.values, selectableCount: 1 } },
    { userJid: sock.user?.id },
  );

  const poll = msg.message.pollCreationMessageV3 || msg.message.pollCreationMessage;
  if (!poll) throw new Error('Could not build the poll message.');

  poll.selectableOptionsCount = 1;
  poll.pollContentType = proto.Message.PollContentType.TEXT;

  if (isQuiz) {
    const correct = spec.values[spec.correctIndex];
    if (correct === undefined) {
      throw new Error(`Quiz correct answer index ${spec.correctIndex} is out of range.`);
    }
    poll.pollType = proto.Message.PollType.QUIZ;
    // WhatsApp Web sends both the option name and sha256(name) as hex.
    poll.correctAnswer = { optionName: correct, optionHash: sha256Hex(correct) };
  }

  return msg;
}

/**
 * Channels are special: the stanza needs a `<meta polltype="...">` sibling node,
 * and Baileys only attaches extra nodes for non-channel stanzas. So we build the
 * channel stanza the same way Baileys does, plus the meta node.
 */
async function sendChannelPoll(sock, jid, msg, isQuiz) {
  await sock.sendNode({
    tag: 'message',
    attrs: { to: jid, id: msg.key.id, type: 'poll' },
    content: [
      {
        tag: 'meta',
        attrs: { polltype: isQuiz ? 'quiz_creation' : 'creation', contenttype: 'text' },
      },
      { tag: 'plaintext', attrs: {}, content: encodeNewsletterMessage(msg.message) },
    ],
  });
  return msg;
}

/**
 * Send a post. `content` is one of:
 *   { text }                       plain text
 *   { poll: { name, values } }     poll with radio buttons
 *   { quiz: { name, values, correctIndex } }   quiz with a correct answer
 *
 * Works for normal chats and for @newsletter channels (the sending account must
 * be OWNER or ADMIN of the channel).
 */
export async function sendPost(sock, jid, content) {
  if (content?.quiz || content?.poll) {
    const isQuiz = Boolean(content.quiz);
    const spec = content.quiz ?? content.poll;
    const msg = await buildPollMessage(sock, jid, spec, isQuiz);

    if (isJidNewsletter(jid)) {
      await sendChannelPoll(sock, jid, msg, isQuiz);
      return { id: msg.key?.id ?? null };
    }

    const sent = await sock.sendMessage(jid, {
      poll: { name: spec.name, values: spec.values, selectableCount: 1 },
    });
    return { id: sent?.key?.id ?? null };
  }

  const payload = typeof content === 'string' ? { text: content } : content;
  try {
    const sent = await sock.sendMessage(jid, payload);
    return { id: sent?.key?.id ?? null };
  } catch (err) {
    if (!payload?.text) throw err;
    console.error(`sendMessage failed (${err.message}); trying raw channel query...`);
    const bytes = proto.Message.encode({ conversation: payload.text }).finish();
    await sock.query({
      tag: 'message',
      attrs: { to: jid, type: 'text' },
      content: [{ tag: 'plaintext', attrs: {}, content: bytes }],
    });
    // The raw query path answers with an IQ, so there is no message id to
    // track — the caller simply skips confirmation for this one.
    return { id: null };
  }
}
