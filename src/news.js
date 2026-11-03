import crypto from 'node:crypto';
import { loadState, saveState } from './state.js';
import { makeSender } from './sender.js';
import { enabledTargets, describeTarget } from './targets.js';

const DEFAULT_NEWS_QUERY = 'latest Haryana government jobs exam notifications HSSC CET police admit card result date';

/**
 * Searches Exa for latest government job and exam announcements.
 * Follows the canonical Exa API guidelines: type "auto", contents with token-efficient highlights.
 */
export async function searchExaNews(query = '', apiKey = '') {
  const key = String(apiKey || process.env.EXA_API_KEY || '').trim();
  if (!key) throw new Error('EXA_API_KEY is not configured.');

  const q = String(query || DEFAULT_NEWS_QUERY).trim();

  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
    },
    body: JSON.stringify({
      query: q,
      type: 'auto',
      numResults: 6,
      contents: { highlights: true },
    }),
  });

  if (!res.ok) {
    throw new Error(`Exa API answered ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();
  const articles = [];

  for (const item of data.results ?? []) {
    if (!item.url) continue;
    const id = crypto.createHash('sha256').update(item.url).digest('hex').slice(0, 16);
    const highlights = (Array.isArray(item.highlights) ? item.highlights : [])
      .map((h) => String(h).trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .slice(0, 3);

    articles.push({
      id,
      title: String(item.title ?? 'Exam Update').trim(),
      url: item.url,
      publishedDate: item.publishedDate ?? null,
      highlights,
    });
  }

  return articles;
}

/**
 * Formats an Exa news item into a clean WhatsApp/Telegram channel bulletin.
 */
export function formatNewsBulletin(article) {
  const lines = [
    '📢 *Govt Job & Exam Alert*',
    '',
    `📌 *${article.title}*`,
  ];

  if (article.highlights && article.highlights.length) {
    lines.push('');
    for (const h of article.highlights) {
      lines.push(`• ${h}`);
    }
  }

  lines.push('');
  lines.push(`🔗 *Official Link:* ${article.url}`);
  lines.push('');
  lines.push('🔔 _Follow this channel for daily exam quizzes, notes, and breaking alerts!_');

  return lines.join('\n');
}

/**
 * Checks Exa for fresh news, skips articles already posted, and optionally posts them.
 */
export async function processExaNews(cfg, sock = null, options = {}) {
  const dryRun = options.dryRun ?? cfg.dryRun ?? false;
  const query = options.query || cfg.newsQuery || DEFAULT_NEWS_QUERY;
  const articles = await searchExaNews(query, cfg.exaApiKey);

  const primaryTarget = cfg.channels?.[0]?.jid ?? 'global';
  const state = loadState(primaryTarget);
  state.postedNewsUrls = state.postedNewsUrls || [];

  const fresh = articles.filter((a) => !state.postedNewsUrls.includes(a.id));

  if (!fresh.length) {
    return { count: 0, articles: [], posted: 0, reason: 'No new articles since last check' };
  }

  const toPost = fresh.slice(0, options.limit ?? 2);
  let postedCount = 0;

  if (!dryRun && sock) {
    const targets = enabledTargets(cfg);
    for (const article of toPost) {
      const text = formatNewsBulletin(article);
      for (const target of targets) {
        const send = makeSender(sock, target);
        await send(text);
      }
      state.postedNewsUrls.push(article.id);
      // Keep list bounded to last 500 URLs
      if (state.postedNewsUrls.length > 500) state.postedNewsUrls.shift();
      postedCount++;
      await new Promise((r) => setTimeout(r, 3000));
    }
    saveState(state);
  }

  return {
    count: fresh.length,
    articles: toPost,
    posted: postedCount,
    dryRun,
  };
}
