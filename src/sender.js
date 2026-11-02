import { sendPost, ackTracker } from './whatsapp.js';
import { sendTelegram } from './telegram.js';
import { describeTarget } from './targets.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How hard each kind of message is retried.
 *
 * The intro and the closing score poll are what make a run look finished, so
 * they get more chances (and they are the messages the user asked to always go
 * out). Questions get a normal retry so one bad moment does not skip a question.
 */
const ATTEMPTS = { intro: 5, summary: 5, question: 3 };

/** How long to wait for WhatsApp to acknowledge a message. */
const ACK_WAIT_MS = Number(process.env.ACK_WAIT_MS ?? 15000);

/**
 * Build the `send(content, { phase })` function the batch engine expects.
 *
 * Returns true when the message is confirmed, false when it was written to the
 * socket but WhatsApp never acknowledged it (so it may not be in the channel).
 *
 * A socket that dies immediately after a write used to look like a success,
 * which silently skipped a question. Every message is now confirmed by the
 * server ack before the question is marked as posted.
 *
 * @param getSock         () => current Baileys socket (may be null)
 * @param ensureConnected async () => void — reconnects if the socket died
 * @param log             (level, text) => void
 */
export function makeSender({ cfg, target, getSock, ensureConnected, log = () => {} }) {
  // 'unknown' until WhatsApp acks something; then 'working'. If this WhatsApp
  // build never reports acks we fall back to 'off' instead of waiting 15s on
  // every single post.
  let ackMode = 'unknown';
  let ackMisses = 0;

  return async function send(content, { phase = 'question' } = {}) {
    const attempts = ATTEMPTS[phase] ?? 3;
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        if (target.kind === 'telegram') {
          await sendTelegram(cfg, target, content);
          return true;
        }

        const socket = getSock();
        if (!socket?.user) throw new Error('WhatsApp is not connected.');
        if (socket.ws && socket.ws.isOpen === false) {
          throw new Error('WhatsApp connection is closing.');
        }

        const sent = await sendPost(socket, target.jid, content);

        // ---- confirm it actually reached WhatsApp
        if (sent?.id && ackMode !== 'off') {
          const tracker = ackTracker(socket);
          if (tracker) {
            try {
              await tracker.wait(sent.id, ACK_WAIT_MS);
              if (ackMode !== 'working') {
                log('info', 'Delivery confirmation on — each post is now verified by WhatsApp.');
              }
              ackMode = 'working';
              return true;
            } catch (err) {
              if (err.code === 'ACK_ERROR') throw err; // rejected outright -> safe to retry

              if (err.code === 'NO_ACK') {
                if (ackMode === 'working') {
                  // Acks are working on this connection, so this one really did
                  // not reach the server. Retrying cannot duplicate it.
                  throw new Error('WhatsApp did not confirm the message — it did not reach the server.');
                }
                ackMisses += 1;
                if (ackMisses >= 2) {
                  ackMode = 'off';
                  log('warn', 'WhatsApp is not reporting delivery acknowledgements on this connection — continuing without confirmation.');
                }
                // No ack yet and we have never seen one: we cannot tell whether
                // it landed. Treat it as sent rather than risk posting it twice.
                return true;
              }
              throw err;
            }
          }
        }

        return true;
      } catch (err) {
        lastError = err;
        if (attempt === attempts) break;

        const waitMs = attempt * 3000;
        log('warn', `${describeTarget(target)} — ${phase} failed (${err.message}). Retry ${attempt}/${attempts - 1} in ${waitMs / 1000}s.`);

        // Most send failures are the socket being replaced, so try to get it back.
        if (target.kind === 'whatsapp' && ensureConnected) {
          try {
            if (!getSock()?.user) await ensureConnected();
          } catch { /* the retry itself will surface the problem */ }
        }
        await sleep(waitMs);
      }
    }

    throw lastError;
  };
}
