# WhatsApp Channel Daily Question Poster

Posts one quiz question per day (or twice a day) from your JSON question banks to a
WhatsApp **Channel**, automatically. Built on [Baileys](https://github.com/WhiskeySockets/Baileys)
(the same engine WAHA uses under the hood, in `NOWEB` mode).

Runs on a laptop — **no Docker, no browser, no paid service required.**

---

## 🖥️ Control Panel (GUI)

Double-click **WhatsApp Poster - Control Panel** on your Desktop.
A black window opens (leave it running) and your browser opens the control panel.

> This is a local web app — no Electron download, no install. The whole thing runs
> on `http://127.0.0.1:8777` and only your machine can reach it.

What you can do in the panel:

The panel is split into four tabs — **Post**, **Channels**, **Automation**, **System** —
with an action bar pinned to the bottom that always shows the current progress and the
**Post now / Stop** buttons, whichever tab you are on.

- **See the QR code** and link your WhatsApp right there (no terminal scanning)
- **See live status** — Connected / Scan QR / Disconnected in the header, click it to jump to System
- **Post to several channels** at once — tick the ones you want, each keeps its own progress
- **Also post to Telegram** — quizzes, polls and text all work there too
- **Pick what to send** — tap module and subtopic chips (or search them) instead of Ctrl+clicking a list; the count of questions that are still unsent updates live
- **Choose a question mix** — Balanced 50 (10 each of Maths, Reasoning, English, Hindi, GK), 10 from every subject, Maths + Reasoning, or Random 50; a mix replaces the topic filter and sets the run length itself
- **Post format** — Quiz (tap to answer, tells you right/wrong), Poll, or plain Text
- **Post Now** — choose how many questions (default 50) and the gap (default 20s); the panel shows how long the run will take
- **Watch progress** in the sticky bottom bar and a scrolling log with an info/warning/error filter
- **Stop** a running batch safely (it finishes the current post first)
- **Preview next** — opens a preview sheet with the exact quiz / poll / question + answer before posting
- **Test** button per channel — sends one "hello" message so you can check you can post there
- **Dry run** checkbox — try everything without sending
- **Grow the channel** (Automation tab) — find public groups, join them slowly, share your channel link once per group; off by default and dry-run by default
- **Re-link WhatsApp** — wipe the session and scan a fresh QR (fixes stuck "440" loops)
- **Reset progress** — start the bank over from question 1 (per channel, or all)

The window that says "Control Panel" is the server. Closing it stops the panel.

### Posting to more than one channel

Every channel you add in **3 · Send to** has its own progress file, so a brand-new
channel starts at question 1 even though your first channel has already seen all
4,688 questions. Ticked channels are posted to one after another in the same run.

Add a channel by pasting its invite link (`https://whatsapp.com/channel/…`) and
clicking **＋ Add channel**. You must be the owner or an admin of it.

### Telegram

Telegram needs a bot, because a normal account cannot post to a channel:

1. Message **@BotFather** in Telegram → `/newbot` → follow the prompts.
2. Copy the token it gives you (looks like `123456789:AAE…`).
3. Open your Telegram channel → **Administrators** → **Add Admin** → pick your bot →
   give it **Post Messages**.
4. Paste the token into the Control Panel and click **🔍 Find my channels**.

It discovers the channel from the `my_chat_member` update Telegram sends when the
bot is added, so do step 3 before searching. Telegram quizzes work exactly like
WhatsApp ones (tap → instant right/wrong), and the closing score poll works too.

### Sending a themed test (e.g. 25 Chemistry questions)

Under **2 · What to send**, ctrl+click topics in **Modules** and/or **Subtopics**.
A subtopic on its own is enough — pick **Chemistry & Environment**, set
**How many questions** to 25, and click **Post Now**. The panel tells you how many
matching questions each channel still has left.

Deselect everything (or hit **Clear selection**) to go back to using all topics.
Progress is still tracked per question, so a themed test never repeats a question
you have already sent — to any run, themed or not.

### Question mixes (presets)

The preset bar under **2 · What to send** builds a run out of per-subject quotas:

| Preset | What it does |
|---|---|
| ⚖️ **Balanced 50** | 10 Quantitative, 10 Reasoning, 10 English, 10 Hindi, 10 General Knowledge |
| 🔢 **10 each** | 10 from every subject that still has unsent questions |
| ➗ **Maths + Reasoning** | 25 + 25 |
| 🎲 **Random 50** | clears the mix, then posts 50 questions in random order |

A mix is a list of `{ module, count }` rows. You can edit any count, add another
subject, or remove a row. **Grouped** sends one subject after another; **Mixed**
cycles through the subjects question by question.

Two rules matter:

- A mix **replaces** the module/subtopic filter. Ticking a topic chip clears the mix,
  and starting a mix clears the chips — the two are different ways to choose questions.
- The **sum of the quotas is the run length**. `batch.size` is ignored while a mix is
  set, so a scheduled run cannot silently cut a 140-question mix down to 50.

If a subject has fewer unsent questions than its quota, the panel says how many are
ready and the run posts what exists instead of borrowing from another subject.

### The first and last message

A run always opens with the intro and closes with the score poll, because a batch
of questions with no header or no ending just looks broken. Both are retried much
harder than the questions (5 attempts with a reconnect between them), a single
failed question no longer aborts the run, and the closing poll is still sent even
if some questions failed. If the intro cannot be delivered after all retries, the
run stops before posting anything rather than dumping 50 questions on its own.

### No silently skipped questions

Writing a message to the socket is not the same as WhatsApp accepting it: if the
connection drops right after the write, the post can vanish while the program
still thinks it succeeded. That is how a question can go missing from the middle
of a run.

Every post is now confirmed by WhatsApp's own acknowledgement before it is
counted:

- an acknowledgement means the post is in the channel;
- a rejection is retried immediately;
- a post that is never acknowledged is retried (up to 3 times), and if it still
  fails the question is **not** marked as posted, so the next run picks it up.

The log confirms this the first time it happens:
`Delivery confirmation on — each post is now verified by WhatsApp.` If your
WhatsApp build ever stops reporting acknowledgements, the log says so instead of
silently pretending everything went out.

### Fixing a gap

If a post ever does not appear, use **Missed a question? Repost it** under
**3 · Send to**: pick the channel, type the number from the question's header
(e.g. the `40` in `Q40`) and click **Repost that question**. It sends that
one question again, with the same option order as the original, and does not
disturb anything else.

Each run numbers its questions from **1**, not by their position in the bank, so
a 50-question run reads `Q1 … Q50` — never `Q4688/4688`. The number in the
header is the number this box expects, and the last run's question list is saved
so `Q40` still means the same question after a restart.


### Three posting styles

| Style | Looks like | Set with |
|---|---|---|
| **`quiz`** (default) | A WhatsApp **Quiz**: subscribers tap an option and instantly see a green tick or a red cross. 50 questions × 20s ≈ 17 minutes | `"style": "quiz"` |
| **`poll`** | A plain poll: tap-to-answer with vote bars, but no right answer shown — so a separate answer post is needed | `"style": "poll"` |
| **`text`** | Plain text: `A) …  B) …  C) …` with "Reply with your answer" | `"style": "text"` |

A quiz already contains its correct answer, so **"post the answer as a separate message" is
turned off automatically** for quiz mode (it would just be a duplicate post).

> ⚠️ **Send 2 questions first** whenever you switch format. WhatsApp Channels are one-way
> broadcasts and quiz messages can be rejected by the server. Set *How many questions* to
> `2`, click **Post Now**, and check your channel. If the message never appears, switch
> **Post format** to `Text` — plain text always works.

### Forwarding a news channel

Card **4 · Forward a news channel** copies the posts of a channel you follow
into your channel(s), once per hour (or any interval from 5 minutes up).

1. Paste the news channel's invite link and click **＋ Add source**. The app
   follows it, which is what lets it see the channel's posts.
2. Tick the destinations under **Post the digest to** — WhatsApp channels,
   Telegram chats, or both. They do not have to be the quiz channels.
3. Set the interval, and optionally a keyword allow-list (`haryana, hssc`) and
   a block-list (`advertisement, join`).
4. Click **Save forwarder**, then **👁 Preview last hour** to see exactly what
   the next digest would contain. **📤 Forward now** sends immediately.

What it does and does not do:

- **Text only.** A picture with a caption is posted as its caption; a picture
  with no text is skipped. Media is not downloaded and re-uploaded, which keeps
  the hourly run light on a phone.
- Every message is de-duplicated against the last 400 forwarded per source, so
  the same news cannot be posted twice even if the fetch overlaps.
- The digest window is the time since the previous run. If the app was off for
  more than 3 hours, only the last hour is sent — a long backlog is never dumped.
- A closed gap (no messages) sends nothing at all; the header only goes out when
  there is at least one message.
- The reading side uses WhatsApp's `newsletterFetchMessages` lookup, with live
  channel updates as a fallback on builds that do not answer that lookup.

### Automatic schedule

Card **5 · Post automatically** starts a run by itself — the daily quiz with
nobody clicking anything.

- **Times** — 24-hour, on the computer's/phone's clock, comma separated:
  `08:00` or `08:00, 20:00`.
- **Days** — leave all seven chips off for every day, or pick the weekdays.
- **Questions / gap** — optional. `0` questions and a blank gap mean "use the
  numbers from card 1".
- The channels ticked in **3 · Send to** are the ones that receive it, so a
  schedule can be quiz-only on one channel.

How it behaves:

- **One slot fires once.** The slot is written to `state.json`
  (`schedule.lastSlot`), so restarting the app inside the same minute cannot
  post the quiz twice.
- **A missed time is skipped, never replayed.** If the phone was off at 08:00,
  you do not get half a quiz at noon.
- The panel checks every 20 seconds, so a phone waking up within the minute
  still catches the slot.
- *Dry run* still applies: a scheduled run then only writes to the log.
- On Android a slot only fires while the poster is running — see
  **Keep it running unattended** under the Android section.

### Recent runs and backups

**Recent runs** lists the last completed runs: when, which channel, how long the run
took, how many were sent or failed, and whether the closing score poll went out. A run
started by the schedule is marked *auto*.

`state/state.json` is written atomically (temporary file, then rename), so a
crash or power cut cannot leave a 0-byte file. Once a day the previous file is
copied to `state/state.backup.json`; `config.json.bak` is the settings from
before the last save. To recover, close the panel/app, copy the backup over the
live file, and start again.

### How the quiz is built

Baileys' built-in poll helper cannot send a quiz (it never sets the correct answer), so the
poster builds the message itself:

- `pollCreationMessageV3` with `pollType = QUIZ` and
  `correctAnswer = { optionName, optionHash: sha256(optionName) }`
- a 32-byte `messageSecret` in `messageContextInfo` (required so votes can be encrypted)
- a channel stanza of `<message type="poll"><meta polltype="quiz_creation" contenttype="text">…`

Because the correct answer is attached to the message, **the option shuffle is what keeps it
honest** — the answer letter is recomputed after shuffling, so it is not always "A".

### Bank clean-up on load

Your question banks came out of PDFs, so a few records are damaged. The loader repairs or
drops them and logs what it did:

| Problem | What the loader does |
|---|---|
| English lost its `______` fill-in-the-blank marker but Hindi kept its own (e.g. `"Haryana is the first state to launch"`) | Puts the marker back: `"Haryana is the first state to launch ______"`. Only touches text that stops mid-sentence, so complete sentences are left alone. |
| Two options read exactly the same (e.g. `A) 7 percent` … `C) 7 percent`) | Drops the question — it cannot be answered. Comparison is deliberately literal, so `-3` vs `3` and `y = b` vs `y = -b` are still treated as different answers. |

Set `"skipDuplicateOptions": false` in `config.json` to keep those questions anyway.

---

## 📱 Android app (standalone APK)

The same Control Panel ships as a self-contained app: Node 18 runs inside the
APK (`libnode.so`), so no PC, no Termux, no extra installs.

- **Install:** copy `android/dist/HSSC-Poster-arm64-v8a.apk` to the phone and
  open it. Android warns about installing from unknown sources — allow it for
  the file manager or browser you used. This is sideload-only: Google Play does
  not accept apps that automate WhatsApp.
- **Requirements:** Android 8.0 or newer, 64-bit ARM phone. The APK is ~34 MB
  and carries all five question banks (4,688 questions).
- **First launch:** the app starts a foreground service (permanent
  notification) and shows the panel. The first start takes ~20 seconds because
  it unpacks 62 MB of JavaScript and banks.
- **Link WhatsApp:** type the number with country code and press
  **Get pairing code**, then on the phone open WhatsApp → **Linked Devices** →
  **Link with phone number** and enter the 8-character code. A QR code is
  useless on the phone that is displaying it, so narrow screens hide it.
- **Add channels:** paste the channel invite link under *Send to* → *Add
  channel*. The linked account must be an owner/admin of that channel. Telegram
  works exactly like the desktop panel (bot token → *Find my channels*).
- **During a run:** the foreground service and a wake lock keep the process
  alive with the screen off. Do not *Force stop* the app and do not remove it
  from the recent-apps list mid-run.
- **Keep it running unattended:** tap **Settings** at the bottom of the app.
  Allow background activity (Android's battery-optimisation exemption) and
  leave *Start automatically after a reboot* ticked. The app asks once, on the
  first launch, because without that exemption Android can freeze a 17-minute
  run. A reboot then restarts the poster by itself and the schedule keeps
  working without opening the app.
- **If Node dies:** the service restarts it up to four times with a widening
  pause, so a crash at 08:00 does not lose the day. The permanent notification
  also shows the last log line (pairing code, Q23/50, digest sent…).
- **Updates:** installing a newer APK keeps the WhatsApp link, `state/`
  progress and `config.json`; the banks are replaced from the new bundle.

### Building the APK

```powershell
cd whatsapp-poster
powershell -File android\tools\build.ps1 -Clean -Release   # shareable APK (no channels, no bot token)
powershell -File android\tools\build.ps1 -Release          # APK with your own config baked in
powershell -File android\tools\build.ps1 -Install          # debug build onto a running emulator
```

Outputs land in `android\app\build\outputs\apk\release\` (one APK per CPU type;
`arm64-v8a` is the one for phones). `-Clean` strips your channel list, Telegram
token and progress, so the result is safe to give away.

The signing key is in `android\keystore\` (passwords in `keystore.properties`).
Keep that folder: Android only accepts updates signed with the same key.

---

## 🖱️ Click-to-run (command-line style)

Two shortcuts are already on your Desktop:

| Shortcut | What it does |
|---|---|
| **Post 50 Questions to WhatsApp** | Posts 50 questions to the channel, 20-second gap between each, plus an intro and a final score poll. ~18 minutes. |
| **Preview WhatsApp Questions** | Shows the next question + answer. Sends nothing. |

Just double-click **Post 50 Questions to WhatsApp** and leave the black window open
until it says FINISHED. It waits 10 seconds first, so you can cancel with `Ctrl+C`.

First time only, run `npm run login` (or double-click the shortcut — if no session
exists, it prints a QR code to scan).

### What gets posted each run

1. An intro: `📘 Daily Quiz — 50 Questions`
2. 50 **quizzes**, **20 seconds apart**, each one tap-to-answer with instant ✓/✗
3. A **score poll** — a question, not plain text:
   ```
   📘 Aaj ke 50 questions complete! ✅

   📚 Indian Polity & Judiciary (4) · General Science (4) · …

   📊 Completed so far: 100/4688

   ❓ What's your score? Tap the band you got 👇
        ○ 50/50 🏆
        ○ 40–49
        ○ 30–39
        ○ 20–29
        ○ 10–19
        ○ Below 10
   ```

Why a poll and not a text message? **A WhatsApp Channel has no replies.** A text
"what's your score?" can never get an answer; a poll gives every subscriber a
tap-to-respond button, and the votes can be read afterwards.

Turn it off, or set your own bands, in `config.json`:
```jsonc
"batch": {
  "scorePoll": true,          // false = plain text summary instead
  "scorePollPrompt": "❓ *What's your score?* Tap the band you got 👇",
  "scoreBands": []            // [] = scale automatically to batch.size
}
```
With `scoreBands` empty the bands are generated from `batch.size` — 50 questions
gives `50/50 🏆, 40–49, 30–39, 20–29, 10–19, Below 10`.

Every post is saved to `state/state.json` as it is sent, so if the run is interrupted
it continues from where it stopped instead of repeating questions.

Change the amount or the gap in `config.json`:
```jsonc
"batch": {
  "size": 50,          // how many questions per run
  "gapSeconds": 20,    // pause between posts
  "style": "quiz",     // "quiz" | "poll" | "text"
  "includeAnswer": false,
  "introMessage": true,
  "scorePrompt": "❓ *What's your score?* Reply with how many you got right 👇"
}
```

Commands: `npm run batch` (or `npm run post`) does the same as the desktop shortcut.

---

## What it does

- Reads one or many JSON question banks (English, Hindi, or bilingual).
- Posts to **any number of WhatsApp channels** (and Telegram), each with its own progress.
- Interleaves subjects round-robin so the channel never gets 20 Polity questions in a row.
- **Shuffles the options** for every question and recomputes the answer letter.
  (Your `Court_Clerk_2000` bank has the correct answer at position A for *all 2000*
  questions — posting it raw would be spotted instantly. This fixes that.)
- Tracks what has already been posted, per channel, in `state/state.json` — no repeats.
- Can post a **themed test**: filter by module or subtopic and send e.g. 25 chemistry questions.
- Two modes:
  - `quiz` (recommended): posts the **question at 08:00**, the **answer + explanation at 20:00**.
  - `single`: posts question + answer + explanation together.
- `dryRun` is **on by default** so nothing is ever sent until you turn it off.

---

## The 10-minute setup

### 1. Install Node.js (already done on this machine)
Node 22 is installed. Dependencies are already installed in this folder.

### 2. Edit `config.json`
```jsonc
{
  "channels": [
    { "jid": "1203630XXXXXXXXXXX@newsletter", "name": "My Channel", "enabled": true }
  ],
  "telegram": { "enabled": false, "botToken": "", "chats": [] },
  "selection": { "modules": [], "subtopics": [], "mode": "sequence" },
  "bankPaths": [ ...your banks... ],
  "mode": "quiz",
  "postTimes": ["08:00", "20:00"],
  "language": "both",       // "en" | "hi" | "both"
  "dryRun": true            // keep true until you are happy with the preview
}
```
Easier: leave `channels` empty and add them from the Control Panel by pasting invite links.

### 3. Find your channel ID
Open your channel in WhatsApp → **Share** → **Copy link**. It looks like
`https://whatsapp.com/channel/0029VaAbCdEfGhIjKlMnOp1q`. Then:

```powershell
npm run jid -- https://whatsapp.com/channel/0029VaAbCdEfGhIjKlMnOp1q
```

Copy the printed `jid` into `channels` in `config.json` — or paste the invite link
straight into the Control Panel's **＋ Add channel** box, which does this for you.
> You must be the **OWNER or ADMIN** of the channel to post to it.

### 4. Preview (no WhatsApp needed)
```powershell
npm run preview
```
This shows the next question *and* its answer exactly as they will appear.

### 5. Link your WhatsApp account
```powershell
npm run login
```
Scan the QR in the terminal (WhatsApp → **Linked Devices** → Link a device).
The session is saved in `auth/`, so you only do this once.

> Prefer a pairing code? Set `"loginMethod": "pairing"` and `"phoneNumber": "91XXXXXXXXXX"` in config.json.

### 6. Test-send one post for real
Set `"dryRun": false` in `config.json`, then:
```powershell
npm run send-now
```
Check your channel. Run it again and it will post the **answer** next (quiz mode).

### 7. Run the scheduler
```powershell
npm start
```
Leave the window open. It posts the question at 08:00 and the answer at 20:00
(Asia/Kolkata by default).

The Control Panel now has the same thing built in, without a second window:
**5 · Post automatically** starts a whole 50-question run at the times you type
and keeps its history in **Recent runs**. Use `npm start` only if you want the
strict one-question-at-08:00 / answer-at-20:00 pattern.

---

## Keeping it running

`npm start` must stay running. Options:

- **Simplest:** open a terminal and leave it open while the laptop is on.
- **Better:** install [pm2](https://pm2.keymetrics.io/) so it restarts on crash / reboot:
  ```powershell
  npm install -g pm2 pm2-windows-startup
  pm2 start src/index.js --name wa-poster -- start
  pm2 save
  pm2-startup install
  ```
- **Windows Task Scheduler:** create a task that runs
  `node C:\Users\ms999\Documents\Default Project\whatsapp-poster\src\index.js start`
  at logon, with *Run whether user is logged on or not*.

The laptop must be **awake and online** at post times. Sleep will delay posts.

---

## ☁️ Running on a cloud host (botkeep, Docker, VPS)

The panel is a normal Node web server, so it runs anywhere Node 18+ runs. Two
things are different from the desktop:

1. **The panel must have a password.** On a public host, set `PANEL_PASSWORD`.
   If you forget, the server generates one on first boot, prints it once, and
   saves it to `auth/panel-password.txt`; you can also set the variable later.
2. **Data must live on a volume.** A redeploy replaces the app folder. Set
   `DATA_DIR` to a mounted folder (for example `/data`) so `config.json`,
   `state/` and `auth/` survive. Without this, a redeploy looks like a brand-new
   install: WhatsApp **Disconnected** and **0 / 4688 sent**.

| Variable | Default | Meaning |
|---|---|---|
| `PANEL_PASSWORD` | *(empty)* | Require a login. Empty + public bind = a generated password |
| `DATA_DIR` | project folder | Where `config.json`, `state/` and `auth/` are kept |
| `SERVER_PORT` / `PORT` | `8777` | Port to listen on (cloud hosts usually set one) |
| `HOST` | loopback locally, `0.0.0.0` when a port env is set | Bind address |
| `EXA_API_KEY` | *(empty)* | Optional; enables “Search web” in the growth card |
| `NO_BROWSER` | *(empty)* | Do not open a local browser (`true` on a server) |
| `NO_CONNECT` | *(empty)* | Do not connect WhatsApp at boot (`true` for a UI-only test) |

Deploy checklist:

1. Put `DATA_DIR` on a **persistent volume** (botkeep: mount it and set the env var).
2. Set `PANEL_PASSWORD` (a long random string) and `NODE_ENV=production`.
3. Upload/extract the bundle and start `node src/gui/server.js` (or `npm start`).
4. Open the URL, sign in, then link WhatsApp from **System**. The QR/session
   files go into `$DATA_DIR/auth`.
5. Open **System → Data folder** and confirm it points at the volume.
6. Reboot/redeploy once and check that the connection and the sent count survive.

Security notes:

- `/api/status` no longer contains the Telegram bot token. The token field in the
  panel stays blank; leaving it blank keeps the saved token, typing a new one
  replaces it.
- Cookies are `HttpOnly`, `SameSite=Lax`, signed with the password, and marked
  `Secure` when the request arrived over HTTPS. Changing `PANEL_PASSWORD` signs
  every session out.
- Failed logins are rate-limited. All routes, including the live event stream,
  require the session cookie.
- `botkeep-deploy.zip` is built **without** the real `config.json` token, `auth/`
  or `state/`. If you make your own zip, do not include those either.
- A public panel controls a live WhatsApp account. Use HTTPS, and do not share
  the URL and password in the same chat.

### Checking that a redeploy really took

A redeploy replaces the running code, so the panel can look unchanged for a
minute. Open these four things after uploading:

| Check | What "new build" looks like |
|---|---|
| Open the URL in a private window | You get the **sign-in page**, not the panel |
| **System** tab | **Panel access** card shows *Password required* and the **Data folder** |
| **Post** tab | The mix preset bar (Balanced 50 / 10 each / Maths + Reasoning / Random 50) |
| **Automation** tab | The **🌱 Grow the channel** card exists, with **Dry run** ticked |

If the sign-in page does not appear, `PANEL_PASSWORD` is empty and the bind is
loopback — check `HOST` and the port variable. If **Data folder** points at the
app folder rather than the volume, `DATA_DIR` is missing and the next redeploy
will wipe the WhatsApp session and the sent count again.

---

## 🌱 Automatic growth (joining groups)

> **Read this first.** WhatsApp treats automated joining and link-dropping as
> spam. This is the feature most likely to get a number banned. It is off by
> default, runs in dry-run mode by default, and is deliberately slow. Use a
> secondary number if you can.

The growth card lives in the **Automation** tab and does five things:

1. **Discover** — paste a public invite link (`chat.whatsapp.com/…`), or set
   `EXA_API_KEY` and use **Search web**. Exa searches the public web; it cannot
   see private groups. Always preview a group before joining it.
2. **Queue** — previewing only reads the group name and member count. Nothing is
   joined yet.
3. **Approve** — a queued group is `Waiting for approval`. Only approved groups
   can be auto-joined.
4. **Join** — respects `joins / day`, `minutes between joins` and `max groups`.
   In dry run it only writes a log line.
5. **Share** — after the group is old enough (`wait before sharing`, default 24h),
   posts your channel link **once**, respecting `shares / day` and the gap.
   Templates use `{link}` and `{name}`.

Safety controls:

| Control | Default | Why |
|---|---|---|
| `enabled` | off | Master kill switch |
| `dryRun` | on | Log actions without touching WhatsApp |
| `joinPerDay` | 3 | Keeps joining under the radar |
| `joinGapMinutes` | 60 | No burst-joining |
| `maxGroups` | 25 | Hard ceiling on membership |
| `shareAfterHours` | 24 | Do not drop a link the second you join |
| `sharePerDay` | 2 | One message, not a campaign |
| `allowlist` | empty | Restrict to known groups |
| `blocked` | empty | Skip groups whose name contains these words |

The background worker looks every 10 minutes. **Run growth now** triggers one
check immediately. Both `auto-join` and `auto-share` must be ticked for it to act
without you. The panel shows exactly why it is waiting (“Next join in 42 min.”,
“Daily share limit reached”, …).

If you only want to share the channel link and not join, do not enable growth;
the same actions are available one group at a time from the card.

---

## Config reference

| Key | Meaning |
|---|---|
| `channels` | Array of `{ jid, name, enabled }` — every WhatsApp channel you post to |
| `channelJid` | Legacy single channel; still read, and kept in sync with `channels[0]` |
| `telegram` | `{ enabled, botToken, chats: [{ chatId, name, enabled }] }` |
| `selection` | `{ modules: [], subtopics: [], mode: "sequence" \| "random", quotas: [{ module, count }], quotaOrder: "grouped" \| "mixed" }` — empty lists mean all topics; a quota mix replaces the filters and sets the run length |
| `bankPaths` | Array of JSON question-bank files (any mix of formats). Relative paths are resolved from the project folder |
| `mode` | `quiz` (Q then A) or `single` (both together) |
| `postTimes` | `["08:00","20:00"]` — 24h, in `timezone` |
| `timezone` | e.g. `Asia/Kolkata` |
| `language` | `en`, `hi`, or `both` |
| `rotateModules` | Interleave subjects round-robin |
| `shuffleOptions` | Randomise option order (strongly recommended) |
| `showModuleTag` / `showSubtopic` / `showQuestionNumber` / `showExplanation` | Post layout toggles |
| `headerEmoji`, `answerEmoji`, `replyPrompt`, `hashtags` | Cosmetic |
| `dryRun` | `true` = print only, never send |
| `loginMethod` | `qr` or `pairing` |
| `phoneNumber` | Only for `pairing` mode (with country code, digits only) |
| `resetWhenFinished` | `true` = restart from the top after all questions are used |
| `schedule` | `{ enabled, times: ["08:00"], weekdays: [], size: 0, gapSeconds: -1, style: "" }` — card 5; `[]` weekdays = every day, `0`/`-1`/`""` = use `batch` |
| `forwarder` | `{ enabled, intervalMinutes, sources, targets, maxPerRun, gapSeconds, header, keywords, blocked }` — card 4 |
| `growth` | `{ enabled, dryRun, channelLink, message, joinPerDay, joinGapMinutes, shareAfterHours, sharePerDay, shareGapMinutes, maxGroups, autoJoin, autoShare, allowlist, blocked }` — group growth; see the growth section |

Batch keys (inside `"batch"`):

| Key | Meaning |
|---|---|
| `size` | Questions per run |
| `gapSeconds` | Pause between posts (20 = well inside every rate limit) |
| `style` | `quiz`, `poll` or `text` |
| `includeAnswer` | Post the answer as a second message (pointless for a quiz) |
| `introMessage` | Post the opening message |
| `scorePoll` | End with a tappable score poll instead of a text summary |
| `scorePollPrompt` | The question line of that poll |
| `scoreBands` | Custom bands for the poll; `[]` scales them to `size` |

Progress lives in `state/state.json`, one record per target:

```json
{
  "version": 2,
  "targets": {
    "wa:120363430301683531@newsletter": { "postedIds": [ "…" ], "pending": null, "history": [], "run": null },
    "tg:@mychannel":                    { "postedIds": [],       "pending": null, "history": [], "run": null }
  },
  "forward": { "sources": {} },
  "runs":   [ { "at": "2026-10-31T08:00:00.000Z", "label": "…", "sent": 50, "failed": 0, "reason": "schedule" } ],
  "schedule": { "lastSlot": "2026-10-31 08:00" }
}
```


---

## Supported question-bank formats

The loader auto-detects all of these — you can mix them in `bankPaths`:

**Format A — Court Clerk master bank**
```json
{ "id": 1, "module": "Indian Polity & Judiciary", "question": "...",
  "options": ["...","...","...","..."], "answer": "1",
  "correct_option_text": "...", "explanation": "..." }
```

**Format B — HSSC volumes (bilingual)**
```json
{ "id": "2018-11-10-shift-1_Q001", "subject": "General Awareness",
  "question_en": "...", "question_hi": "...",
  "options": { "A": {"en":"...","hi":"..."}, "B": {...} },
  "correct_answer": "C", "explanation": "" }
```

Also handled: plain `options` objects (`{"A":"...","B":"..."}`), arrays of options,
`answer` as letter or number, and duplicate questions across files (auto-removed).

**Loading with the current config: 4,688 unique questions** from 5 bank files
(repeated questions across the HSSC volumes are removed automatically).

At 2 posts/day that is roughly **9–10 years** of content.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Set a valid "channelJid"` | Run step 3, paste the `@newsletter` ID |
| `bank file does not exist` | Check the paths in `bankPaths` (use forward slashes `/`) |
| QR never appears | Delete the `auth/` folder and run `npm run login` again |
| `Logged out` | Delete `auth/`, re-run `npm run login` |
| Nothing posts at the scheduled time | Laptop asleep/offline, or the `npm start` window was closed |
| Message sent but channel shows nothing | The linked account is not OWNER/ADMIN of that channel |
| `Another instance is already using the WhatsApp session` | Close the other Control Panel / terminal window first — two programs cannot share one session. To fill a gap, use **Missed a question? Repost it** instead of starting a second copy |

---

## ⚠️ Read this before you go live

- Channels are not supported by WhatsApp's **official** API. This uses an
  **unofficial** client, which technically violates WhatsApp's Terms of Service.
- Posting ~2 messages/day is very low volume and low risk, but **use a secondary
  SIM number**, not your personal one.
- Never buy followers or mass-message subscribers. Keep it to scheduled posts only.
- If the linked number gets logged out, just re-link.

## Alternative: WAHA (if you later want Docker / a REST API)

[WAHA](https://github.com/devlikeapro/waha) exposes the same capability over HTTP
(`POST /api/sendText` with `chatId: "123@newsletter"`) plus a `GET /api/{session}/channels`
endpoint that lists your channels directly. Useful if you want to drive posting from
n8n, Python, or a server. Docker is not installed on this machine, so Baileys direct
was the faster path.
