/**
 * Telegram posting via the Bot API (plain HTTPS, no library needed).
 *
 * A bot can post to a channel once it is an ADMIN of that channel with the
 * "Post Messages" permission. Quizzes are native here: sendPoll with
 * type: "quiz" gives the same tap-to-answer with right/wrong feedback that the
 * WhatsApp side uses.
 */

const API = 'https://api.telegram.org';

// Telegram's own limits (Question 1-300, option 1-100, explanation 0-200).
export const TG_QUESTION_MAX = 300;
export const TG_OPTION_MAX = 100;
export const TG_EXPLANATION_MAX = 200;
export const TG_MAX_OPTIONS = 10;

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** WhatsApp-style *bold* / _italic_ -> Telegram HTML. */
function toHtml(text) {
  return escapeHtml(text)
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1<i>$2</i>');
}

/** Strip the WhatsApp markup for fields that cannot carry it (polls). */
function toPlain(text) {
  return String(text)
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .trim();
}

function token(cfg) {
  const value = cfg.telegram?.botToken;
  if (!value) {
    throw new Error('Telegram is not set up yet — paste your bot token in the Control Panel.');
  }
  return value;
}

export async function telegramCall(cfg, method, payload = {}) {
  let res;
  try {
    res = await fetch(`${API}/bot${token(cfg)}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`Could not reach Telegram (${err.message}). Check your internet connection.`);
  }
  const data = await res.json().catch(() => null);
  if (!data?.ok) {
    const description = data?.description ?? `HTTP ${res.status}`;
    if (/chat not found/i.test(description)) {
      throw new Error('Telegram says "chat not found" — check the chat ID, and make sure the bot is an admin of the channel.');
    }
    if (/not enough rights|CHAT_ADMIN_REQUIRED|not a member/i.test(description)) {
      throw new Error('The bot is not allowed to post there. Add the bot as an admin of the channel with "Post Messages".');
    }
    if (/unauthorized|not found/i.test(description)) {
      throw new Error(
        'Telegram does not accept this bot token. Open @BotFather in Telegram, send /mybots, '
        + 'pick your bot, choose "API Token" and copy the whole token again (looks like 123456789:AA…).',
      );
    }
    throw new Error(`Telegram rejected ${method}: ${description}`);
  }
  return data.result;
}

/** Bot identity — also a quick way to prove a token is valid. */
export function telegramMe(cfg) {
  return telegramCall(cfg, 'getMe');
}

/**
 * Recent updates. Adding the bot to a channel produces a "my_chat_member"
 * update that carries the chat id, which is how we discover channels.
 */
export function telegramUpdates(cfg) {
  return telegramCall(cfg, 'getUpdates', { limit: 100, timeout: 0 });
}

export function telegramChatInfo(cfg, chatId) {
  return telegramCall(cfg, 'getChat', { chat_id: chatId });
}

/** Channels/groups the bot has recently been added to or has seen activity in. */
export function chatsFromUpdates(updates) {
  const found = new Map();
  for (const update of updates ?? []) {
    const chat =
      update.my_chat_member?.chat ??
      update.channel_post?.chat ??
      update.message?.chat ??
      update.edited_channel_post?.chat ??
      null;
    if (!chat?.id) continue;
    const username = chat.username ? `@${chat.username}` : '';
    found.set(String(chat.id), {
      chatId: String(chat.id),
      username,
      name: chat.title ?? username ?? String(chat.id),
      type: chat.type,
    });
  }
  return [...found.values()];
}

/**
 * Send one content object ({ text } | { poll } | { quiz }) to a Telegram chat.
 */
export async function sendTelegram(cfg, target, content) {
  const chatId = target.chatId;

  if (content?.quiz || content?.poll) {
    const isQuiz = Boolean(content.quiz);
    const spec = content.quiz ?? content.poll;
    const options = (spec.values ?? [])
      .slice(0, TG_MAX_OPTIONS)
      .map((text) => ({ text: toPlain(text).slice(0, TG_OPTION_MAX) }));
    if (options.length < 2) throw new Error('A Telegram poll needs at least 2 options.');

    const payload = {
      chat_id: chatId,
      question: toPlain(spec.name).slice(0, TG_QUESTION_MAX),
      options,
      is_anonymous: true,
      type: isQuiz ? 'quiz' : 'regular',
    };

    if (isQuiz) {
      const index = Number(spec.correctIndex ?? 0);
      payload.correct_option_id = index >= 0 && index < options.length ? index : 0;
      const explanation = toPlain(spec.explanation ?? '');
      if (explanation) payload.explanation = explanation.slice(0, TG_EXPLANATION_MAX);
    }

    return telegramCall(cfg, 'sendPoll', payload);
  }

  const text = typeof content === 'string' ? content : content?.text ?? '';
  try {
    return await telegramCall(cfg, 'sendMessage', {
      chat_id: chatId,
      text: toHtml(text),
      parse_mode: 'HTML',
    });
  } catch (err) {
    // A stray * or _ can break the HTML parse — send it plainly instead of losing it.
    if (!/parse|entit|tag|unsupported/i.test(err.message)) throw err;
    return telegramCall(cfg, 'sendMessage', {
      chat_id: chatId,
      text: toPlain(text),
    });
  }
}
