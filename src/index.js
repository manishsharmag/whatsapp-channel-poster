import cron from 'node-cron';
import { loadConfig } from './config.js';
import { saveState, targetState, stateFile, nextDailyNumber } from './state.js';
import { optionOrder } from './format.js';
import { connectWhatsApp } from './whatsapp.js';
import { enabledTargets, describeTarget } from './targets.js';
import { makeSender } from './sender.js';
import { acquireLock } from './lock.js';
import {
  loadPool,
  previewNext,
  runBatch,
  describeContent,
  questionContents,
  answerContent,
  buildContents,
} from './batch.js';

const cmd = (process.argv[2] ?? 'preview').toLowerCase();
const cfg = loadConfig();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sock = null;
let shuttingDown = false;

function targets() {
  const list = enabledTargets(cfg);
  if (!list.length) {
    throw new Error('No channel selected. Add one in config.json ("channels") or in the Control Panel.');
  }
  return list;
}

/** The channel used by preview / the scheduler's "pending answer" lookup. */
function primaryTargetKey() {
  return enabledTargets(cfg)[0]?.key ?? cfg.channels[0]?.jid ?? '';
}

function describePool(pool) {
  console.log(`📚 Loaded ${pool.queue.length} usable questions (skipped ${pool.skipped}, removed ${pool.duplicates} duplicates).`);
  if (pool.badOptions) console.log(`   Dropped ${pool.badOptions} with duplicate/broken options.`);
  const sel = cfg.selection;
  if (sel.modules.length || sel.subtopics.length) {
    console.log(`   Filter  : ${[...sel.modules, ...sel.subtopics].join(', ')}`);
  }
  console.log(`   State   : ${stateFile()}`);
  console.log(`   Targets : ${enabledTargets(cfg).map(describeTarget).join(' + ') || '(none)'} | language: ${cfg.language} | dryRun: ${cfg.dryRun}`);
}

async function connect() {
  sock = await connectWhatsApp(cfg, {
    onClose: (statusCode, loggedOut) => {
      sock = null;
      if (loggedOut || shuttingDown) return;
      console.log('   reconnecting in 5s...');
      setTimeout(() => connect().catch((e) => console.error('Reconnect failed:', e.message)), 5000);
    },
  });
  return sock;
}

async function waitForConnection(timeoutMs = 180000) {
  const started = Date.now();
  while (!sock?.user) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for WhatsApp connection');
    await sleep(2000);
  }
}

async function preview() {
  const pool = loadPool(cfg, primaryTargetKey());
  describePool(pool);
  const next = previewNext(cfg, primaryTargetKey());

  if (next.finished) {
    console.log('\n🎉 Nothing left to post — every question has been sent.');
    return;
  }

  const kind = next.mode === 'quiz' ? 'QUIZ' : next.mode === 'poll' ? 'POLL' : 'QUESTION';
  console.log(`\n----- ${kind} — Q${next.number} (first of the next run) -----`);
  if (next.quiz) console.log(describeContent({ quiz: next.quiz }));
  else if (next.poll) console.log(describeContent({ poll: next.poll }));
  else console.log(next.questionText);
  if (next.quiz) console.log(`(correct answer: ${next.correctLetter})`);
  console.log(`\n----- ANSWER (posted at ${cfg.postTimes[1] ?? '?'}) -----\n${next.answerText}\n`);
  console.log(`(preview only — nothing sent, state unchanged. ${next.covered} already posted here.)`);
}

async function doBatch() {
  const list = targets();
  const stubbed = process.env.SEND_STUB === 'true';
  const willSend = stubbed || !cfg.dryRun;

  if (!willSend) {
    console.log('🅳  dryRun is on — printing only, nothing will be sent.\n');
  } else if (!stubbed) {
    if (!sock) throw new Error('Not connected to WhatsApp.');
  }

  describePool(loadPool(cfg, list[0].key));

  let totalSent = 0;
  let totalFailed = 0;

  for (const [i, target] of list.entries()) {
    if (list.length > 1) console.log(`\n════ Target ${i + 1}/${list.length}: ${describeTarget(target)} ════`);

    const rawSend = makeSender({
      cfg,
      target,
      getSock: () => sock,
      ensureConnected: connect,
      log: (_level, text) => console.log(`   ${text}`),
    });

    const send = async (content, meta) => {
      console.log(`\n${describeContent(content)}\n`);
      if (stubbed) return void console.log('🧪 SEND_STUB=true — simulated send.');
      if (cfg.dryRun) return void console.log('🅳 dryRun — not sent.');
      await rawSend(content, meta);
      console.log('📤 Sent');
    };

    const result = await runBatch({
      cfg,
      targetKey: target.key,
      send,
      // Never record progress for a stub: the questions were not really sent.
      commit: willSend && !cfg.dryRun && !stubbed,
      onEvent: (e) => {
        if (e.type === 'batchStart') {
          const mins = Math.ceil((e.planned * (cfg.batch.gapSeconds + 1)) / 60);
          console.log(`🚀 Batch: ${e.planned} questions, ${cfg.batch.gapSeconds}s gap (~${mins} min).`);
        } else if (e.type === 'postFailed') {
          console.log(`⚠️  Question ${e.index} failed: ${e.message}`);
        } else if (e.type === 'summaryFailed') {
          console.log(`⚠️  The closing score poll could not be sent: ${e.message}`);
        }
      },
    });

    totalSent += result.sent;
    totalFailed += result.failed ?? 0;
    if (result.finished) console.log('🎉 Every question has already been posted here.');
    else console.log(`✅ ${describeTarget(target)} — ${result.sent} sent${result.failed ? `, ${result.failed} failed` : ''}. Covered ${result.covered}/${result.total}.`);
    if (result.unconfirmed?.length) {
      console.log(`⚠️  WhatsApp did not confirm: Q${result.unconfirmed.join(', Q')}.`);
      console.log('   Repost them from the Control Panel ("Missed a question? Repost it").');
    }
  }

  if (list.length > 1) console.log(`\n🏁 All done — ${totalSent} sent${totalFailed ? `, ${totalFailed} failed` : ''}.`);
}

/** Scheduled mode: posts one question, or reveals the pending answer. */
async function postScheduled() {
  const list = targets();
  const key = primaryTargetKey();
  const pool = loadPool(cfg, key);
  const target = pool.target;

  if (cfg.mode === 'quiz' && target.pending) {
    const q = pool.queue.find((x) => x.id === target.pending.id);
    if (q) {
      // Same number as the question post, so the answer lines up.
      const number = target.pending.number ?? target.daily?.last ?? 1;
      const ctx = { cfg, number, order: optionOrder(q, cfg.shuffleOptions) };
      const content = answerContent(q, ctx);
      console.log(`\n${describeContent(content)}\n`);
      if (!cfg.dryRun) {
        for (const t of list) {
          await makeSender({ cfg, target: t, getSock: () => sock, ensureConnected: connect })(content, { phase: 'summary' });
        }
        target.pending = null;
        saveState(pool.state);
        console.log('📤 Sent');
      }
      return;
    }
    target.pending = null;
  }

  const q = pool.queue.find((x) => !pool.posted.has(x.id));
  if (!q) {
    console.log('🎉 Every question has already been posted.');
    return;
  }

  // One-at-a-time posting: number by the day's count, not the bank position.
  const number = nextDailyNumber(target);
  const ctx = { cfg, number, order: optionOrder(q, cfg.shuffleOptions) };
  const contents = cfg.mode === 'single' ? buildContents(q, ctx) : questionContents(q, ctx);

  for (const content of contents) {
    console.log(`\n${describeContent(content)}\n`);
    if (!cfg.dryRun) {
      for (const t of list) {
        await makeSender({ cfg, target: t, getSock: () => sock, ensureConnected: connect })(content, { phase: 'question' });
      }
      console.log('📤 Sent');
    }
  }

  if (!cfg.dryRun) {
    if (!target.postedIds.includes(q.id)) target.postedIds.push(q.id);
    if (cfg.mode === 'quiz') target.pending = { id: q.id, postedAt: new Date().toISOString(), number };
    saveState(pool.state);
  }
}

async function login() {
  console.log('Connecting to WhatsApp for login...');
  await connectWhatsApp(cfg, {
    onOpen: () => {
      console.log('Session saved to ./auth/ — you can now run `npm start`.');
      setTimeout(() => process.exit(0), 3000);
    },
    onClose: (code, loggedOut) => {
      if (loggedOut) process.exit(1);
    },
  });
}

async function resolveChannel() {
  const input = process.argv[3] || cfg.channels[0]?.jid;
  if (!input || input.includes('PUT_YOUR')) {
    throw new Error('Usage: node src/index.js jid <channel-invite-link-or-code>');
  }
  console.log('Connecting...');
  await connect();
  await waitForConnection();

  const code = String(input).replace(/.*channel\//i, '').replace(/[^0-9A-Za-z]/g, '');
  const meta = await sock.newsletterMetadata('invite', code);
  console.log(`\n${JSON.stringify(meta, null, 2)}`);
  if (meta?.id) {
    console.log(`\n👉 Add this to config.json under "channels":\n   { "jid": "${meta.id}", "name": ${JSON.stringify(meta.name ?? '')}, "enabled": true }`);
  }
  process.exit(0);
}

async function start() {
  const list = targets();
  describePool(loadPool(cfg, list[0].key));

  if (cfg.dryRun) console.log('⚠️  dryRun is ON — scheduled posts will only be printed.');

  await connect();

  const schedule = (time) => {
    const [h, m] = time.split(':').map(Number);
    cron.schedule(`${m} ${h} * * *`, async () => {
      console.log(`\n⏰ [${new Date().toLocaleString('en-IN', { timeZone: cfg.timezone })}] job fired`);
      try {
        await waitForConnection();
        await postScheduled();
      } catch (err) {
        console.error(`❌ Job failed: ${err.message}`);
      }
    }, { timezone: cfg.timezone });
    console.log(`   ⏱️  scheduled at ${time} (${cfg.timezone})`);
  };

  if (cfg.mode === 'quiz') {
    cfg.postTimes.slice(0, 2).forEach(schedule);
  } else {
    cfg.postTimes.forEach(schedule);
  }

  console.log('\n✅ Scheduler running. Keep this window open. Press Ctrl+C to stop.\n');
  process.on('SIGINT', () => {
    shuttingDown = true;
    console.log('\n👋 Stopped.');
    process.exit(0);
  });
}

async function main() {
  try {
    // The CLI must not share ./auth with the Control Panel: two sockets on one
    // session make WhatsApp close both (code 440/428) and can drop messages.
    // If run on Botkeep or cloud with SERVER_PORT, delegate 'start' to the GUI server.
    if (cmd === 'start' && (process.env.SERVER_PORT || process.env.PORT)) {
      console.log(`🌐 Cloud hosting detected (PORT: ${process.env.SERVER_PORT || process.env.PORT}). Starting Web Control Panel...`);
      await import('./gui/server.js');
      return;
    }

    if (['batch', 'post', 'login', 'start', 'jid'].includes(cmd)) {
      acquireLock(`cli ${cmd}`);
    }
    if (cmd === 'preview') return await preview();
    if (cmd === 'batch' || cmd === 'post') {
      const stubbed = process.env.SEND_STUB === 'true';
      if (!cfg.dryRun && !stubbed) {
        await connect();
        await waitForConnection();
      }
      await doBatch();
      process.exit(0);
    }
    if (cmd === 'gui') {
      await import('./gui/server.js');
      return;
    }
    if (cmd === 'login') return await login();
    if (cmd === 'start') return await start();
    if (cmd === 'jid') return await resolveChannel();
    console.log('Usage: node src/index.js [batch|preview|login|start|jid]');
  } catch (err) {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  }
}

main();
