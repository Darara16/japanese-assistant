const OpenAI     = require('openai');
const { google } = require('googleapis');

const SPREADSHEET_ID = '1_xf4eMikaE02-2ZLffLFD1qCKf1y3s5of_CNI3XipWs';

// ── Auth ────────────────────────────────────────────────
async function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/calendar'
    ]
  });
}

// ── Read one sheet tab → array of objects ───────────────
async function getSheet(sheets, tabName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabName}!A:Z`
  });
  const [header, ...rows] = res.data.values;
  return rows.map(row =>
    Object.fromEntries(header.map((h, i) => [h.trim(), (row[i] || '').trim()]))
  );
}

// ── Today as DD/MM/YYYY ─────────────────────────────────
function todayString() {
  const now  = new Date();
  const dd   = String(now.getDate()).padStart(2, '0');
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// ── Commit HTML to gh-pages using GITHUB_TOKEN ──────────
async function saveHtmlToGitHub(html, dayNum) {
  const fileName = `japanese_study_day${dayNum}.html`;
  const repo     = process.env.GITHUB_REPOSITORY;
  const token    = process.env.GITHUB_TOKEN;  // auto-provided by Actions, never in HTML
  const branch   = 'gh-pages';
  const url      = `https://api.github.com/repos/${repo}/contents/${fileName}`;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
    'Accept':        'application/vnd.github.v3+json'
  };

  let sha;
  const check = await fetch(`${url}?ref=${branch}`, { headers });
  if (check.ok) {
    const existing = await check.json();
    sha = existing.sha;
  }

  const body = {
    message: `Day ${dayNum} study file`,
    content: Buffer.from(html).toString('base64'),
    branch
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method:  'PUT',
    headers,
    body:    JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub Pages commit failed: ${err}`);
  }

  const owner    = repo.split('/')[0].toLowerCase();
  const repoName = repo.split('/')[1];
  return `https://${owner}.github.io/${repoName}/${fileName}`;
}

// ── Mark day done in Google Sheets ──────────────────────
async function markDayDone(sheets, dayNum) {
  const sheetRow = dayNum + 1; // row 1 = header, row 2 = day 1
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range:         `Schedule!G${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody:   { values: [['TRUE']] }
  });
  console.log(`Sheet: Day ${dayNum} marked TRUE`);
}

// ── Create Google Calendar event ────────────────────────
async function createCalendarEvent(calendar, dayData, fileUrl) {
  const calendarId = process.env.CALENDAR_ID || 'primary';
  const [dd, mm, yyyy] = dayData.date.split('/');
  const dateStr = `${yyyy}-${mm}-${dd}`;
  const summary = `Japanese Study — Day ${dayData.day} of 60`;

  const existing = await calendar.events.list({
    calendarId,
    timeMin:      `${dateStr}T05:00:00Z`,
    timeMax:      `${dateStr}T07:00:00Z`,
    q:            summary,
    singleEvents: true
  });

  const eventBody = {
    summary,
    description: [
      `Day ${dayData.day} of 60 · N4 · ${dayData.date}`,
      '',
      `Kanji:   ${dayData.kanji.map(k => k.kanji).join('  ')}`,
      `Vocab:   ${dayData.vocab.slice(0, 5).map(v => v.word).join(', ')} ...`,
      `Podcast: ${dayData.podcast.title_jp || ''}`,
      '',
      `Study file: ${fileUrl}`
    ].join('\n'),
    start: { dateTime: `${dateStr}T06:00:00`, timeZone: 'Europe/Vienna' },
    end:   { dateTime: `${dateStr}T07:00:00`, timeZone: 'Europe/Vienna' },
    reminders: {
      useDefault: false,
      overrides:  [{ method: 'popup', minutes: 0 }]
    },
    colorId: '7'
  };

  if (existing.data.items.length > 0) {
    await calendar.events.update({
      calendarId,
      eventId:     existing.data.items[0].id,
      requestBody: eventBody
    });
    console.log('Calendar event updated');
  } else {
    await calendar.events.insert({ calendarId, requestBody: eventBody });
    console.log('Calendar event created');
  }
}

// ── ntfy push notification ──────────────────────────────
async function sendNotification(day, fileUrl) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) { console.log('No NTFY_TOPIC - skipping'); return; }
  
  const safeUrl = fileUrl.replace(/[^\x00-\x7F]/g, '');
  const message = `Day ${day} study file ready. Open: ${safeUrl}`;
  
  await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    body:   Buffer.from(message, 'ascii').toString(),
    headers: {
      'Title':    `Japanese Study Day ${day}`,
      'Priority': 'default',
      'Tags':     'jp',
      'Content-Type': 'text/plain'
    }
  });
  console.log('Push notification sent');
}

// ── Build prompt for OpenAI ─────────────────────────────
function buildPrompt(d) {
  const pct = ((d.day / 60) * 100).toFixed(2);

  return `You are a Japanese study HTML renderer. Your job is to fill content into a fixed HTML template. You must NOT invent any design, layout, or CSS. Output only valid HTML starting with <!DOCTYPE html>.

ABSOLUTE RULES — violations will break the product:
1. Copy the EXACT CSS from the STYLE BLOCK below — do not add, remove, or change a single CSS rule
2. Copy the EXACT HTML STRUCTURE from the STRUCTURE BLOCK below — do not add or remove any elements
3. Only replace the CONTENT PLACEHOLDERS with today's data
4. Do not add any extra divs, classes, styles, or scripts beyond what is specified
5. Output raw HTML only — no markdown, no code fences, no explanation

════════════════════════════════════════
STYLE BLOCK — copy this verbatim into <style>
════════════════════════════════════════
:root {
  --bg: #daeaf7;
  --bg-grad: linear-gradient(145deg, #e8f4fd 0%, #d0e8f5 50%, #c8e0f0 100%);
  --nm-out: 6px 6px 14px #a8c8e0, -6px -6px 14px #ffffff;
  --nm-card: 8px 8px 22px #9fc0db, -8px -8px 22px #ffffff;
  --nm-in: inset 4px 4px 10px #a8c8e0, inset -4px -4px 10px #ffffff;
  --nm-press: inset 3px 3px 8px #a8c8e0, inset -3px -3px 8px #ffffff;
  --accent: linear-gradient(135deg, #1a6fa8, #26c6da);
  --text-1: #0d2d4a;
  --text-2: #2e6080;
  --text-3: #6e9ab5;
  --text-4: #9bbdd0;
  --r: 18px;
  --rs: 12px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Segoe UI', Arial, sans-serif;
  background: var(--bg-grad);
  background-attachment: fixed;
  color: var(--text-1);
  min-height: 100vh;
  padding: 32px 16px 80px;
}
body::before, body::after {
  content: ''; position: fixed; border-radius: 50%;
  pointer-events: none; z-index: 0; filter: blur(80px); opacity: 0.22;
}
body::before { width: 480px; height: 480px; background: radial-gradient(circle, #2196f3, transparent); top: -80px; right: -80px; }
body::after  { width: 380px; height: 380px; background: radial-gradient(circle, #26c6da, transparent); bottom: -60px; left: -60px; }
.wrap { max-width: 860px; margin: 0 auto; position: relative; z-index: 1; }

/* HEADER */
.header { text-align: center; margin-bottom: 40px; }
.pills { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.pill { background: var(--bg); box-shadow: var(--nm-out); border-radius: 50px; padding: 5px 18px; font-size: 11px; font-weight: 700; letter-spacing: 1.8px; text-transform: uppercase; color: var(--text-2); }
.pill-accent { background: linear-gradient(135deg, #1a6fa8, #26c6da); box-shadow: 0 4px 16px rgba(26,111,168,0.35); color: #fff; }
.header h1 { font-size: clamp(24px, 5vw, 38px); font-weight: 800; letter-spacing: -0.5px; margin-bottom: 6px; }
.header h1 span { background: linear-gradient(135deg, #1a6fa8, #26c6da); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.header p { font-size: 13px; color: var(--text-3); }
.prog-wrap { max-width: 600px; margin: 20px auto 0; }
.prog-track { background: var(--bg); box-shadow: var(--nm-in); border-radius: 50px; height: 10px; overflow: hidden; }
.prog-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #1a6fa8, #26c6da); border-radius: 50px; transition: width 1.4s cubic-bezier(.4,0,.2,1); }
.prog-labels { display: flex; justify-content: space-between; margin-top: 6px; font-size: 11px; color: var(--text-3); font-weight: 600; }

/* SECTION */
.section { background: var(--bg); box-shadow: var(--nm-card); border-radius: var(--r); padding: 24px 24px 22px; margin-bottom: 22px; opacity: 0; transform: translateY(18px); transition: opacity 0.5s ease, transform 0.5s ease; }
.section.visible { opacity: 1; transform: translateY(0); }
.sec-head { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid rgba(26,111,168,0.10); }
.sec-icon { width: 44px; height: 44px; background: linear-gradient(135deg, #1a6fa8, #26c6da); box-shadow: 0 4px 14px rgba(26,111,168,0.30); border-radius: var(--rs); display: flex; align-items: center; justify-content: center; font-size: 18px; color: #fff; flex-shrink: 0; }
.sec-title { font-size: 12px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; color: var(--text-2); }
.sec-sub { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.sec-count { margin-left: auto; background: var(--bg); box-shadow: var(--nm-out); border-radius: 50px; padding: 3px 12px; font-size: 11px; font-weight: 700; color: var(--text-3); white-space: nowrap; }

/* KANJI */
.kanji-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
.k-card { background: var(--bg); box-shadow: var(--nm-out); border-radius: var(--rs); padding: 18px 16px; }
.k-char { font-size: 54px; font-weight: 800; line-height: 1; color: var(--text-1); margin-bottom: 10px; text-shadow: 2px 2px 5px #a8c8e0, -1px -1px 3px #fff; }
.k-meaning { font-size: 11px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; background: linear-gradient(135deg, #1a6fa8, #26c6da); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; margin-bottom: 8px; }
.k-readings { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.k-pill { background: var(--bg); box-shadow: var(--nm-press); border-radius: 50px; padding: 3px 10px; font-size: 11px; font-weight: 600; color: var(--text-2); }
.k-pill span { color: var(--text-4); font-size: 10px; margin-right: 3px; }
.k-words { font-size: 12px; color: var(--text-3); line-height: 1.7; margin-bottom: 10px; }
.k-ex { background: var(--bg); box-shadow: var(--nm-in); border-radius: var(--rs); padding: 10px 12px; }
.k-ex .jp { font-size: 13px; color: var(--text-1); font-weight: 500; line-height: 1.5; }
.k-ex .en { font-size: 11px; color: var(--text-3); font-style: italic; margin-top: 3px; }

/* VOCAB */
.v-list { display: flex; flex-direction: column; gap: 8px; }
.v-item { background: var(--bg); box-shadow: var(--nm-out); border-radius: var(--rs); padding: 12px 14px; display: grid; grid-template-columns: 150px 1fr; gap: 10px 16px; align-items: start; }
.v-word { font-size: 17px; font-weight: 700; color: var(--text-1); line-height: 1.2; }
.v-read { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.v-meaning { font-size: 11px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase; background: linear-gradient(135deg, #1a6fa8, #26c6da); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; margin-bottom: 4px; }
.v-jp { font-size: 13px; color: var(--text-1); font-weight: 500; line-height: 1.5; }
.v-en { font-size: 11px; color: var(--text-3); font-style: italic; margin-top: 2px; }
@media (max-width: 480px) { .v-item { grid-template-columns: 1fr; } }

/* SHADOWING */
.s-list { display: flex; flex-direction: column; gap: 8px; }
.s-item { background: var(--bg); box-shadow: var(--nm-out); border-radius: var(--rs); padding: 13px 16px; display: flex; align-items: flex-start; gap: 12px; }
.s-num { width: 26px; height: 26px; background: var(--bg); box-shadow: var(--nm-out); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; color: #1a6fa8; flex-shrink: 0; margin-top: 2px; }
.s-content { flex: 1; }
.s-pattern { font-size: 10px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; background: linear-gradient(135deg, #1a6fa8, #26c6da); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; margin-bottom: 4px; }
.s-jp { font-size: 15px; color: var(--text-1); font-weight: 600; line-height: 1.5; }
.s-hint { font-size: 11px; color: var(--text-3); font-style: italic; margin-top: 3px; }
.s-play { width: 32px; height: 32px; background: linear-gradient(135deg, #1a6fa8, #26c6da); border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: #fff; font-size: 11px; }

/* PODCAST */
.pod-card { background: var(--bg); box-shadow: var(--nm-out); border-radius: var(--rs); overflow: hidden; }
.pod-banner { background: linear-gradient(135deg, #1a6fa8, #26c6da); padding: 18px 20px; display: flex; align-items: flex-start; gap: 14px; }
.pod-thumb { width: 56px; height: 56px; background: rgba(255,255,255,0.18); border-radius: var(--rs); display: flex; align-items: center; justify-content: center; font-size: 24px; flex-shrink: 0; }
.pod-ep { font-size: 10px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; color: rgba(255,255,255,0.7); margin-bottom: 4px; }
.pod-title { font-size: 15px; font-weight: 700; color: #fff; line-height: 1.4; margin-bottom: 4px; }
.pod-furi { font-size: 11px; color: rgba(255,255,255,0.75); line-height: 1.6; }
.pod-body { padding: 18px 20px; }
.pod-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.pod-tag { background: var(--bg); box-shadow: var(--nm-press); border-radius: 50px; padding: 3px 10px; font-size: 11px; font-weight: 700; color: #1a6fa8; }
.pod-reason { background: var(--bg); box-shadow: var(--nm-in); border-radius: var(--rs); padding: 12px 14px; font-size: 13px; color: var(--text-2); line-height: 1.65; margin-bottom: 14px; }
.pod-reason strong { color: #1a6fa8; }
.pod-phrases { display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px; }
.pod-phrase { background: var(--bg); box-shadow: var(--nm-out); border-radius: var(--rs); padding: 9px 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pod-phrase .pjp { font-size: 14px; font-weight: 700; color: var(--text-1); }
.pod-phrase .parr { color: var(--text-4); font-size: 12px; }
.pod-phrase .pen { font-size: 12px; color: var(--text-2); }
.pod-link { display: inline-flex; align-items: center; gap: 6px; background: linear-gradient(135deg, #1a6fa8, #26c6da); box-shadow: 0 4px 14px rgba(26,111,168,0.35); border-radius: 50px; padding: 11px 26px; text-decoration: none; font-size: 13px; font-weight: 700; color: #fff; }

/* DRILLS */
.d-list { display: flex; flex-direction: column; gap: 14px; }
.d-item { background: var(--bg); box-shadow: var(--nm-out); border-radius: var(--rs); padding: 16px 18px; }
.d-label { font-size: 10px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase; color: var(--text-4); margin-bottom: 3px; }
.d-orig { font-size: 14px; font-weight: 700; color: var(--text-1); margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid rgba(26,111,168,0.10); }
.d-vars { display: flex; flex-direction: column; gap: 7px; }
.d-var { background: var(--bg); box-shadow: var(--nm-in); border-radius: var(--rs); padding: 10px 12px; display: flex; gap: 10px; align-items: flex-start; }
.d-badge { background: var(--bg); box-shadow: var(--nm-out); border-radius: 50px; padding: 2px 9px; font-size: 10px; font-weight: 800; color: #1a6fa8; white-space: nowrap; flex-shrink: 0; margin-top: 2px; }
.d-text { font-size: 13px; color: var(--text-1); line-height: 1.55; }
.d-note { font-size: 11px; color: var(--text-3); margin-top: 2px; font-style: italic; }

/* COMPLETION */
.done-wrap { text-align: center; padding: 20px 16px; }
.stat-pills { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; margin-bottom: 22px; }
.stat-pill { background: var(--bg); box-shadow: var(--nm-out); border-radius: 50px; padding: 7px 16px; font-size: 12px; font-weight: 700; color: var(--text-2); display: flex; align-items: center; gap: 5px; }
.stat-pill b { background: linear-gradient(135deg, #1a6fa8, #26c6da); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; font-size: 15px; }
.done-btn { background: var(--bg); box-shadow: var(--nm-card); border: none; border-radius: 50px; padding: 16px 48px; font-size: 15px; font-weight: 800; color: var(--text-1); cursor: pointer; transition: box-shadow 0.2s, transform 0.15s; outline: none; }
.done-btn:hover { box-shadow: 10px 10px 26px #9fc0db, -10px -10px 26px #fff; }
.done-btn:active { box-shadow: var(--nm-press); transform: scale(0.98); }
.done-note { font-size: 12px; color: var(--text-3); margin-top: 12px; }
#confetti-canvas { position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 999; }

════════════════════════════════════════
STRUCTURE BLOCK — copy this verbatim, only replace <!-- CONTENT --> markers
════════════════════════════════════════
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Japanese Study - Day ${d.day}</title>
<style><!-- PASTE STYLE BLOCK HERE --></style>
</head>
<body>
<canvas id="confetti-canvas"></canvas>
<div class="wrap">

  <div class="header">
    <div class="pills">
      <div class="pill pill-accent">Day ${d.day} of 60</div>
      <div class="pill">N4 &middot; 2026</div>
      <div class="pill">${d.date}</div>
    </div>
    <h1>Japanese Study <span>&#26085;&#26412;&#35486;</span></h1>
    <p>Daily session &middot; Kanji &middot; Vocabulary &middot; Shadowing &middot; Podcast</p>
    <div class="prog-wrap">
      <div class="prog-track"><div class="prog-fill" id="progressFill"></div></div>
      <div class="prog-labels"><span>Day ${d.day}</span><span>${pct}%</span><span>Day 60</span></div>
    </div>
  </div>

  <!-- SECTION 1: KANJI -->
  <div class="section">
    <div class="sec-head">
      <div class="sec-icon">&#31558;</div>
      <div><div class="sec-title">Kanji</div><div class="sec-sub"><!-- KANJI IDS --></div></div>
      <div class="sec-count">${d.kanji.length} characters</div>
    </div>
    <div class="kanji-grid">
      <!-- KANJI CARDS: for each kanji render:
      <div class="k-card">
        <div class="k-char">KANJI_CHARACTER</div>
        <div class="k-meaning">MEANING</div>
        <div class="k-readings">
          <div class="k-pill"><span>on</span>ONYOMI</div>
          <div class="k-pill"><span>kun</span>KUNYOMI</div>
        </div>
        <div class="k-words">COMMON_WORDS_WITH_FURIGANA</div>
        <div class="k-ex">
          <div class="jp">EXAMPLE_JAPANESE</div>
          <div class="en">EXAMPLE_ENGLISH</div>
        </div>
      </div>
      -->
    </div>
  </div>

  <!-- SECTION 2: VOCABULARY -->
  <div class="section">
    <div class="sec-head">
      <div class="sec-icon">&#35486;</div>
      <div><div class="sec-title">Vocabulary</div><div class="sec-sub"><!-- VOCAB IDS --></div></div>
      <div class="sec-count">${d.vocab.length} words</div>
    </div>
    <div class="v-list">
      <!-- VOCAB ITEMS: for each vocab render:
      <div class="v-item">
        <div>
          <div class="v-word">WORD</div>
          <div class="v-read">READING</div>
        </div>
        <div>
          <div class="v-meaning">MEANING</div>
          <div class="v-jp">SENTENCE_JP</div>
          <div class="v-en">SENTENCE_EN</div>
        </div>
      </div>
      -->
    </div>
  </div>

  <!-- SECTION 3: SHADOWING -->
  <div class="section">
    <div class="sec-head">
      <div class="sec-icon">&#127897;</div>
      <div><div class="sec-title">Shadowing</div><div class="sec-sub">Reiko sentences</div></div>
      <div class="sec-count">10 sentences</div>
    </div>
    <div class="s-list">
      <!-- SHADOW ITEMS: for each shadow render:
      <div class="s-item">
        <div class="s-num">NUMBER</div>
        <div class="s-content">
          <div class="s-pattern">GRAMMAR_PATTERN</div>
          <div class="s-jp">JAPANESE_SENTENCE</div>
          <div class="s-hint">ENGLISH_HINT</div>
        </div>
        <div class="s-play">&#9654;</div>
      </div>
      -->
    </div>
  </div>

  <!-- SECTION 4: PODCAST -->
  <div class="section">
    <div class="sec-head">
      <div class="sec-icon">&#128251;</div>
      <div><div class="sec-title">Podcast</div><div class="sec-sub"><!-- PODCAST ID --></div></div>
      <div class="sec-count"><!-- DURATION --> min</div>
    </div>
    <div class="pod-card">
      <div class="pod-banner">
        <div class="pod-thumb">&#127911;</div>
        <div>
          <div class="pod-ep"><!-- EPISODE NUMBER --></div>
          <div class="pod-title"><!-- TITLE JP --></div>
          <div class="pod-furi"><!-- TITLE FURIGANA --></div>
        </div>
      </div>
      <div class="pod-body">
        <div class="pod-tags"><!-- TAG PILLS --></div>
        <div class="pod-reason"><!-- REASON TIED TO TODAY VOCAB --></div>
        <div class="pod-phrases">
          <!-- 3 PHRASE ROWS -->
        </div>
        <a class="pod-link" href="<!-- URL -->" target="_blank" rel="noopener">&#9654;&nbsp; Open Episode</a>
      </div>
    </div>
  </div>

  <!-- SECTION 5: SPEAKING DRILLS -->
  <div class="section">
    <div class="sec-head">
      <div class="sec-icon">&#128483;</div>
      <div><div class="sec-title">Speaking Drills</div><div class="sec-sub">First 5 sentences x 2 variations</div></div>
      <div class="sec-count">5 x 2</div>
    </div>
    <div class="d-list">
      <!-- DRILL ITEMS: for each of first 5 shadow sentences render:
      <div class="d-item">
        <div class="d-label">Original</div>
        <div class="d-orig">ORIGINAL_SENTENCE</div>
        <div class="d-vars">
          <div class="d-var">
            <div class="d-badge">Casual</div>
            <div><div class="d-text">CASUAL_VARIATION</div><div class="d-note">CHANGE_NOTES</div></div>
          </div>
          <div class="d-var">
            <div class="d-badge">Formal</div>
            <div><div class="d-text">FORMAL_VARIATION</div><div class="d-note">CHANGE_NOTES</div></div>
          </div>
        </div>
      </div>
      -->
    </div>
  </div>

  <!-- SECTION 6: COMPLETION -->
  <div class="section">
    <div class="done-wrap">
      <div class="stat-pills">
        <div class="stat-pill"><b>${d.kanji.length}</b> kanji</div>
        <div class="stat-pill"><b>${d.vocab.length}</b> vocab</div>
        <div class="stat-pill"><b>10</b> shadowing</div>
        <div class="stat-pill"><b>1</b> podcast</div>
      </div>
      <button class="done-btn" id="doneBtn" onclick="markDone()">&#10003;&nbsp; Mark as Done</button>
      <div class="done-note" id="doneNote">${60 - d.day} days remaining after today</div>
    </div>
  </div>

</div>
<script>
const io = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.07 });
document.querySelectorAll('.section').forEach(s => io.observe(s));

window.addEventListener('load', () => {
  setTimeout(() => { document.getElementById('progressFill').style.width = '${pct}%'; }, 500);
});

function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  const colors = ['#1a6fa8','#26c6da','#4fc3f7','#81d4fa','#b3e5fc','#ffffff','#e1f5fe'];
  const pieces = Array.from({length:140}, () => ({
    x: Math.random()*canvas.width, y: Math.random()*-canvas.height,
    r: Math.random()*7+2, d: Math.random()*2.5+1,
    color: colors[Math.floor(Math.random()*colors.length)],
    tilt: Math.random()*10-5, tiltAngle:0, tiltSpeed:Math.random()*0.1+0.04,
    shape: Math.random()>0.5?'circle':'rect'
  }));
  let frame=0;
  function draw() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    pieces.forEach(p => {
      p.tiltAngle+=p.tiltSpeed; p.y+=p.d; p.tilt=Math.sin(p.tiltAngle)*12;
      ctx.beginPath(); ctx.fillStyle=p.color;
      if(p.shape==='circle'){ctx.arc(p.x+p.tilt,p.y,p.r,0,Math.PI*2);ctx.fill();}
      else{ctx.fillRect(p.x+p.tilt,p.y,p.r*2,p.r);}
    });
    frame++;
    if(frame<200) requestAnimationFrame(draw);
    else ctx.clearRect(0,0,canvas.width,canvas.height);
  }
  draw();
}

function markDone() {
  const btn = document.getElementById('doneBtn');
  const note = document.getElementById('doneNote');
  if (btn.classList.contains('done')) return;
  btn.classList.add('done');
  btn.innerHTML = '&#127800;&nbsp; Day ${d.day} Complete!';
  btn.style.background = 'linear-gradient(135deg,#1a6fa8,#26c6da)';
  btn.style.color = '#fff';
  btn.style.boxShadow = '0 6px 22px rgba(26,111,168,0.40)';
  note.textContent = 'Great work. See you tomorrow for Day ${d.day + 1}.';
  launchConfetti();
  try { localStorage.setItem('jpstudy_day${d.day}_done','true'); } catch(e) {}
  fetch('https://api.github.com/repos/${repo}/actions/workflows/mark-done.yml/dispatches', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ${process.env.DONE_BUTTON_PAT}',
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json'
    },
    body: JSON.stringify({ ref: 'main', inputs: { day: '${d.day}', date: '${d.date}' } })
  }).catch(e => console.log('Status update failed:', e));
}

try {
  if (localStorage.getItem('jpstudy_day${d.day}_done')==='true') {
    const btn=document.getElementById('doneBtn');
    btn.classList.add('done');
    btn.innerHTML='&#127800;&nbsp; Day ${d.day} Complete!';
    btn.style.background='linear-gradient(135deg,#1a6fa8,#26c6da)';
    btn.style.color='#fff';
    btn.style.boxShadow='0 6px 22px rgba(26,111,168,0.40)';
    document.getElementById('doneNote').textContent='Great work. See you tomorrow for Day ${d.day + 1}.';
  }
} catch(e) {}
</script>
</body>
</html>

════════════════════════════════════════
CONTENT TO RENDER — use these exact values, do not modify any Japanese text
════════════════════════════════════════

KANJI DATA (render one .k-card per item, include both example_english AND example_japanese):
${JSON.stringify(d.kanji, null, 2)}

VOCABULARY DATA (render one .v-item per item, include sentence_example_en as .v-en):
${JSON.stringify(d.vocab, null, 2)}

SHADOWING DATA (render one .s-item per item, split example field on " — " to get JP sentence and English hint):
${JSON.stringify(d.shadow, null, 2)}

PODCAST DATA (render one podcast card, use url field for the Open Episode link):
${JSON.stringify(d.podcast, null, 2)}`;
}
// ── Call OpenAI ─────────────────────────────────────────
async function generateHtml(dayData) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const msg = await client.chat.completions.create({
    model:      'gpt-4o-mini',
    max_tokens: 16000,
    messages:   [{ role: 'user', content: buildPrompt(dayData) }]
  });
  return msg.choices[0].message.content;
}

// ── MAIN ────────────────────────────────────────────────
async function run() {
  console.log('Starting JP Study generation...');

  const auth     = await getAuth();
  const sheets   = google.sheets({ version: 'v4', auth });
  const calendar = google.calendar({ version: 'v3', auth });

  console.log('Loading sheets...');
  const [schedule, vocabSheet, kanjiSheet, podcastSheet, shadowSheet] = await Promise.all([
    getSheet(sheets, 'Schedule'),
    getSheet(sheets, 'n4_vocab'),
    getSheet(sheets, 'n4_kanji'),
    getSheet(sheets, 'japanese_podcast_kb'),
    getSheet(sheets, 'reiko_patterns_examples')
  ]);
  console.log(`Loaded — schedule:${schedule.length} vocab:${vocabSheet.length} kanji:${kanjiSheet.length} podcast:${podcastSheet.length} shadow:${shadowSheet.length}`);

  // Find today
  const today = todayString();
  const row   = schedule.find(r => r.Date === today);
  if (!row) {
    console.log(`No row for ${today} — nothing to do.`);
    process.exit(0);
  }
  console.log(`Day ${row.Day} → ${today}`);

  // Parse IDs
  const kanjiIds  = row.N4_Kanji.split(',').map(s => s.trim()).filter(Boolean);
  const vocabIds  = row.N4_vocab.split(',').map(s => s.trim()).filter(Boolean);
  const podcastId = row.N4_Podcast.trim();
  const shadowIds = row.Reiko_shadow.split(',').map(s => s.trim()).filter(Boolean);

  // Lookup by first column
  const kanji   = kanjiIds.map(id => kanjiSheet.find(r   => Object.values(r)[0] === id) || {});
  const vocab   = vocabIds.map(id => vocabSheet.find(r   => Object.values(r)[0] === id) || {});
  const podcast = podcastSheet.find(r  => Object.values(r)[0] === podcastId) || {};
  const shadow  = shadowIds.map(id => shadowSheet.find(r  => Object.values(r)[0] === id) || {});

  console.log(`Resolved — kanji:${kanji.length} vocab:${vocab.length} shadow:${shadow.length} podcast:${Object.keys(podcast).length > 0}`);

  const dayData = { day: parseInt(row.Day), date: today, kanji, vocab, podcast, shadow };

  // Generate HTML
  console.log('Calling OpenAI API...');
  const html = await generateHtml(dayData);
  console.log(`HTML generated: ${html.length} chars`);

  // Commit to gh-pages using GITHUB_TOKEN (never touches HTML)
  const fileUrl = await saveHtmlToGitHub(html, dayData.day);
  console.log(`Published: ${fileUrl}`);

  // Mark today as done in Sheet
  await markDayDone(sheets, dayData.day);

  // Calendar + notification
  await createCalendarEvent(calendar, dayData, fileUrl);
  await sendNotification(dayData.day, fileUrl);

  console.log(`\n✓ Done → ${fileUrl}`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
