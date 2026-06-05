const Anthropic  = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const SPREADSHEET_ID = '1_xf4eMikaE02-2ZLffLFD1qCKf1y3s5of_CNI3XipWs';

// ── Auth (Sheets + Calendar only — no Drive needed) ─────
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

// ── Read a sheet tab ────────────────────────────────────
async function getSheet(sheets, name) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${name}!A:Z`
  });
  const [header, ...rows] = res.data.values;
  return rows.map(row =>
    Object.fromEntries(header.map((h, i) => [h.trim(), (row[i] || '').trim()]))
  );
}

// ── Find today's row ────────────────────────────────────
function getTodayRow(schedule) {
  const now  = new Date();
  const dd   = String(now.getDate()).padStart(2, '0');
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const todayStr = `${dd}/${mm}/${yyyy}`;
  return {
    todayStr,
    row: schedule.find(r => r.Date === todayStr)
  };
}

// ── Lookup IDs from a sheet ─────────────────────────────
function lookup(data, ids) {
  return ids
    .map(id => id.trim())
    .filter(Boolean)
    .map(id => data.find(r => r.ID === id || r.Id === id) || {});
}

function parseIds(str) {
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

// ── Save HTML to GitHub Pages (gh-pages branch) ─────────
async function saveHtmlToGitHub(html, dayNum) {
  const fileName = `japanese_study_day${dayNum}.html`;
  const repo     = process.env.GITHUB_REPOSITORY;
  const pat      = process.env.GITHUB_PAT;
  const branch   = 'gh-pages';
  const apiBase  = `https://api.github.com/repos/${repo}/contents/${fileName}`;

  const headers = {
    'Authorization': `Bearer ${pat}`,
    'Content-Type':  'application/json',
    'Accept':        'application/vnd.github.v3+json'
  };

  // Check if file already exists (need SHA to update)
  let sha;
  const check = await fetch(`${apiBase}?ref=${branch}`, { headers });
  if (check.ok) {
    const existing = await check.json();
    sha = existing.sha;
  }

  // Commit the file to gh-pages branch
  const body = {
    message: `Day ${dayNum} study file`,
    content: Buffer.from(html).toString('base64'),
    branch
  };
  if (sha) body.sha = sha;

  const res = await fetch(apiBase, {
    method:  'PUT',
    headers,
    body:    JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub commit failed: ${err}`);
  }

  const owner    = repo.split('/')[0].toLowerCase();
  const repoName = repo.split('/')[1];
  const fileUrl  = `https://${owner}.github.io/${repoName}/japanese_study_day${dayNum}.html`;
  console.log(`Committed to gh-pages: ${fileUrl}`);
  return fileUrl;
}

// ── Create / update Google Calendar event ───────────────
async function createCalendarEvent(calendar, dayData, fileUrl) {
  const calendarId = process.env.CALENDAR_ID || 'primary';
  const [dd, mm, yyyy] = dayData.date.split('/');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  const existing = await calendar.events.list({
    calendarId,
    timeMin: `${dateStr}T05:00:00Z`,
    timeMax: `${dateStr}T07:00:00Z`,
    q: `Japanese Study Day ${dayData.day}`,
    singleEvents: true
  });

  const eventBody = {
    summary: `🇯🇵 Japanese Study — Day ${dayData.day} of 60`,
    description: [
      `Day ${dayData.day} of 60 · N4 · ${dayData.date}`,
      ``,
      `📖 Today's content:`,
      `• Kanji: ${dayData.kanji.map(k => k.kanji || k.ID).join('  ')}`,
      `• Vocabulary: ${dayData.vocab.slice(0, 4).map(v => v.word || v.ID).join(', ')} + ${dayData.vocab.length - 4} more`,
      `• Shadowing: ${dayData.shadow.length} sentences · ${dayData.shadow[0]?.['Grammar Pattern / Word'] || ''}`,
      `• Podcast: ${dayData.podcast?.title || ''}`,
      ``,
      `🔗 Open study file:`,
      fileUrl,
      ``,
      `✅ Mark as Done directly in the study file.`
    ].join('\n'),
    start: {
      dateTime: `${dateStr}T06:00:00`,
      timeZone: 'Europe/Vienna'
    },
    end: {
      dateTime: `${dateStr}T07:00:00`,
      timeZone: 'Europe/Vienna'
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 0 }
      ]
    },
    colorId: '7'
  };

  if (existing.data.items.length > 0) {
    await calendar.events.update({
      calendarId,
      eventId: existing.data.items[0].id,
      requestBody: eventBody
    });
    console.log(`Updated Calendar event for Day ${dayData.day}`);
  } else {
    const event = await calendar.events.insert({
      calendarId,
      requestBody: eventBody
    });
    console.log(`Created Calendar event: ${event.data.htmlLink}`);
  }
}

// ── Send ntfy push notification ─────────────────────────
async function sendNotification(dayData, fileUrl) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;

  await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    body:   `Open your study file → ${fileUrl}`,
    headers: {
      'Title':    `🇯🇵 Day ${dayData.day} — Study time!`,
      'Priority': 'default',
      'Tags':     'japan,books'
    }
  });
  console.log('Push notification sent');
}

// ── Generate HTML via Claude ────────────────────────────
async function generateHtml(dayData, fileUrl) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const msg = await client.messages.create({
    model:      'claude-opus-4-5',
    max_tokens: 16000,
    messages:   [{ role: 'user', content: buildPrompt(dayData, fileUrl) }]
  });

  return msg.content[0].text;
}

// ── Build Claude prompt ─────────────────────────────────
function buildPrompt(d, fileUrl) {
  const repo      = process.env.GITHUB_REPOSITORY || 'Darara16/japanese-assistant-';
  const pat       = process.env.GITHUB_PAT        || '';
  const pct       = ((d.day / 60) * 100).toFixed(2);

  return `You are a Japanese study HTML renderer.
Generate a complete standalone HTML file for Day ${d.day} of 60 (date: ${d.date}).

Ocean Neumorphism theme:
- BG: linear-gradient(145deg,#e8f4fd,#d0e8f5,#c8e0f0) fixed attachment
- Decorative blur orbs: top-right #2196f3 / bottom-left #26c6da, opacity 0.25, blur 80px, z-index 0
- Shadows out: 6px 6px 14px #a8c8e0,-6px -6px 14px #ffffff
- Shadows in: inset 4px 4px 10px #a8c8e0,inset -4px -4px 10px #ffffff
- Card shadow: 8px 8px 22px #9fc0db,-8px -8px 22px #ffffff
- Accent gradient: linear-gradient(135deg,#1a6fa8,#26c6da)
- Text: primary #0d2d4a / secondary #2e6080 / muted #6e9ab5 / faint #9bbdd0
- Border radius: 18px cards, 12px inner elements, 50px pills

Sections in order:

1. HEADER
- Pill badges: "Day ${d.day} of 60" (gradient pill), "N4 · 2026", "${d.date}"
- Title: Japanese Study 日本語
- Subtitle: Daily session · Kanji · Vocabulary · Shadowing · Podcast
- Progress bar: ${pct}% filled with accent gradient, showing Day ${d.day} / Day 60 labels

2. KANJI (${d.kanji.length} cards in a responsive grid)
Each card: large character (58px), meaning (gradient text, uppercase), on/kun reading pills (neumorphic pressed), common words, inset example box with JP sentence + EN translation

3. VOCABULARY (${d.vocab.length} items)
Each item: neumorphic card, 2-column grid (word+reading left, meaning+sentence right), meaning in gradient uppercase text, JP sentence, EN translation in muted italic

4. SHADOWING (10 sentences)
Each item: numbered circle, grammar pattern label (gradient text), full JP sentence (16px), English hint (muted italic), gradient play button (decorative)

5. PODCAST
Gradient banner with: episode number, Japanese title, furigana title
Body: tag pills, reason box (inset, tied to today's vocab), 3 key phrase rows, gradient "Open Episode" link button

6. SPEAKING DRILLS
First 5 shadowing sentences × 2 variations each (casual + formal/written/texting)
Show original, then each variation with a badge (Casual/Formal/etc) and change notes in muted italic

7. COMPLETION
Stat pills: ${d.kanji.length} kanji · ${d.vocab.length} vocab · 10 shadowing · 1 podcast
Mark as Done button (large, neumorphic)
On click: button turns gradient, shows "🌸 Day ${d.day} Complete!", fires ocean confetti, saves to localStorage key jpstudy_day${d.day}_done, AND calls GitHub to trigger mark-done workflow

CRITICAL — the Mark as Done button must call this exact JS function:
async function markDone() {
  const btn = document.getElementById('doneBtn');
  const note = document.getElementById('doneNote');
  if (btn.classList.contains('done')) return;
  btn.classList.add('done');
  btn.innerHTML = '🌸 &nbsp; Day ${d.day} Complete!';
  note.textContent = 'Great work. See you tomorrow for Day ${d.day + 1}.';
  launchConfetti();
  try { localStorage.setItem('jpstudy_day${d.day}_done', 'true'); } catch(e) {}
  try {
    await fetch('https://api.github.com/repos/${repo}/dispatches', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ${pat}',
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        event_type: 'mark-done',
        client_payload: { day: ${d.day}, date: '${d.date}' }
      })
    });
  } catch(e) { console.log('Status update failed:', e); }
}

Restore completed state on page load:
try {
  if (localStorage.getItem('jpstudy_day${d.day}_done') === 'true') {
    const btn = document.getElementById('doneBtn');
    btn.classList.add('done');
    btn.innerHTML = '🌸 &nbsp; Day ${d.day} Complete!';
    document.getElementById('doneNote').textContent = 'Great work. See you tomorrow for Day ${d.day + 1}.';
  }
} catch(e) {}

Ocean confetti function: 140 pieces, colors ['#1a6fa8','#26c6da','#4fc3f7','#81d4fa','#b3e5fc','#ffffff','#e1f5fe'], mix of circles and rectangles, 200 frames then clear.

Scroll reveal: IntersectionObserver, threshold 0.07, adds class 'visible', sections start opacity 0 translateY(20px), transition 0.55s ease.

DATA — use this exact content, do not invent or modify any Japanese text:

KANJI:
${JSON.stringify(d.kanji, null, 2)}

VOCABULARY:
${JSON.stringify(d.vocab, null, 2)}

SHADOWING:
${JSON.stringify(d.shadow, null, 2)}

PODCAST:
${JSON.stringify(d.podcast, null, 2)}

Output: raw HTML only. No markdown. No explanation. No code fences. Start with <!DOCTYPE html>.`;
}

// ── Main ────────────────────────────────────────────────
async function run() {
  console.log('Starting JP Study generation...');

  const auth     = await getAuth();
  const sheets   = google.sheets({ version: 'v4', auth });
  const calendar = google.calendar({ version: 'v3', auth });

  // Read all sheet tabs in parallel
  const [schedule, kanjiData, vocabData, podData, shadowData] = await Promise.all([
    getSheet(sheets, 'Schedule'),
    getSheet(sheets, 'n4_vocab'),
    getSheet(sheets, 'n4_kanji'),
    getSheet(sheets, 'reiko_patterns_examples'),
    getSheet(sheets, 'japanese_podcast_kb')
  ]);

  // Find today's row
  const { row, todayStr } = getTodayRow(schedule);
  if (!row) {
    console.log(`No schedule row found for ${todayStr} — nothing to do.`);
    process.exit(0);
  }
  console.log(`Found Day ${row.Day} for ${todayStr}`);

  // Build day data
  const dayData = {
    day:     parseInt(row.Day),
    date:    row.Date,
    kanji:   lookup(kanjiData,  parseIds(row.n4_kanji)),
    vocab:   lookup(vocabData,  parseIds(row.n4_vocab)),
    podcast: lookup(podData,   [row.japanese_podcast_kb])[0] || {},
    shadow:  lookup(shadowData, parseIds(row.reiko_patterns_examples))
  };

  // Build the file URL (we know it before generating)
  const repo     = process.env.GITHUB_REPOSITORY;
  const owner    = repo.split('/')[0].toLowerCase();
  const repoName = repo.split('/')[1];
  const fileUrl  = `https://${owner}.github.io/${repoName}/japanese_study_day${dayData.day}.html`;
  console.log(`File will be at: ${fileUrl}`);

  // Generate HTML via Claude
  console.log('Calling Claude API...');
  const html = await generateHtml(dayData, fileUrl);
  console.log(`HTML generated: ${html.length} chars`);

  // Commit to gh-pages
  await saveHtmlToGitHub(html, dayData.day);

  // Create Google Calendar event
  await createCalendarEvent(calendar, dayData, fileUrl);

  // Send push notification
  await sendNotification(dayData, fileUrl);

  console.log(`\n✓ Day ${dayData.day} complete → ${fileUrl}`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
