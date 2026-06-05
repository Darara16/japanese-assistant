const Anthropic  = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const { Readable } = require('stream');

const SPREADSHEET_ID = '1_xf4eMikaE02-2ZLffLFD1qCKf1y3s5of_CNI3XipWs';

// ── Auth ────────────────────────────────────────────────
async function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
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
  return {
    todayStr: `${dd}/${mm}/${yyyy}`,
    row: schedule.find(r => r.Date === `${dd}/${mm}/${yyyy}`)
  };
}

// ── Lookup IDs ──────────────────────────────────────────
function lookup(data, ids) {
  return ids
    .map(id => id.trim())
    .filter(Boolean)
    .map(id => data.find(r => r.ID === id) || {});
}

function parseIds(str) {
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

// ── Generate HTML via Claude ────────────────────────────
async function generateHtml(dayData, driveFileUrl) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const msg = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: buildPrompt(dayData, driveFileUrl)
    }]
  });

  return msg.content[0].text;
}

// ── Build Claude prompt ─────────────────────────────────
function buildPrompt(d, driveFileUrl) {
  const GITHUB_REPO  = process.env.GITHUB_REPOSITORY || 'Darara16/japanese-assistant-';
  const GITHUB_PAT   = process.env.GITHUB_PAT || 'YOUR_GITHUB_PAT';
  const pct          = ((d.day / 60) * 100).toFixed(2);

  return `You are a Japanese study HTML renderer.
Generate a complete standalone HTML file for Day ${d.day} of 60 (date: ${d.date}).

Ocean Neumorphism theme:
- BG: linear-gradient(145deg,#e8f4fd,#d0e8f5,#c8e0f0) fixed
- Blur orbs: top-right #2196f3 / bottom-left #26c6da opacity 0.25
- Shadows out: 6px 6px 14px #a8c8e0,-6px -6px 14px #ffffff
- Shadows in: inset 4px 4px 10px #a8c8e0,inset -4px -4px 10px #ffffff
- Accent gradient: linear-gradient(135deg,#1a6fa8,#26c6da)
- Text: primary #0d2d4a / secondary #2e6080 / muted #6e9ab5 / faint #9bbdd0
- Border radius: 18px cards, 12px inner, 50px pills

Sections in order:
1. Header — "Day ${d.day} of 60", date "${d.date}", progress bar at ${pct}%, pill badges (Day ${d.day} of 60 / N4 · 2026 / ${d.date})
2. Kanji cards grid — ${d.kanji.length} cards, each: large character, meaning (gradient text), on/kun reading pills, common words, example JP + EN in inset box
3. Vocabulary list — ${d.vocab.length} items, each: word + reading left col, meaning (gradient uppercase) + JP sentence + EN sentence right col
4. Shadowing list — 10 items, each: numbered circle, pattern label (gradient text), full JP sentence, English hint, gradient play button
5. Podcast card — gradient banner with thumb + ep number + title + furigana, tags, reason box (inset), 3 key phrase rows, gradient open link button
6. Speaking Drills — first 5 shadow sentences × 2 variations each (casual + formal/written/texting), show change notes
7. Completion — stat pills (3 kanji / 12 vocab / 10 shadowing / 1 podcast), Mark as Done button, ocean confetti on click

CRITICAL — Mark as Done button must use exactly this JS:
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
    await fetch('https://api.github.com/repos/${GITHUB_REPO}/dispatches', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ${GITHUB_PAT}',
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        event_type: 'mark-done',
        client_payload: { day: ${d.day}, date: '${d.date}' }
      })
    });
  } catch(e) { console.log('Sheet update failed:', e); }
}

Restore state on load:
try {
  if (localStorage.getItem('jpstudy_day${d.day}_done') === 'true') {
    const btn = document.getElementById('doneBtn');
    btn.classList.add('done');
    btn.innerHTML = '🌸 &nbsp; Day ${d.day} Complete!';
    document.getElementById('doneNote').textContent = 'Great work. See you tomorrow for Day ${d.day + 1}.';
  }
} catch(e) {}

DATA:
KANJI: ${JSON.stringify(d.kanji)}
VOCAB: ${JSON.stringify(d.vocab)}
SHADOW: ${JSON.stringify(d.shadow)}
PODCAST: ${JSON.stringify(d.podcast)}

Output raw HTML only. No markdown. No explanation. No code fences.`;
}

// ── Save HTML to Google Drive ───────────────────────────
async function saveHtmlToDrive(drive, html, dayNum) {
  const fileName = `japanese_study_day${dayNum}.html`;

  const existing = await drive.files.list({
    q: `name='${fileName}' and trashed=false`,
    fields: 'files(id)'
  });

  const media = {
    mimeType: 'text/html',
    body: Readable.from([html])
  };

  let fileId;

  if (existing.data.files.length > 0) {
    fileId = existing.data.files[0].id;
    await drive.files.update({ fileId, media });
    console.log(`Updated existing Drive file: ${fileId}`);
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: 'text/html',
        parents: [process.env.DRIVE_FOLDER_ID]   // ← saves into YOUR folder
      },
      media,
      fields: 'id'
    });
    fileId = created.data.id;
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' }
    });
    console.log(`Created new Drive file: ${fileId}`);
  }

  return `https://drive.google.com/file/d/${fileId}/view`;
}

// ── Create Google Calendar event ────────────────────────
async function createCalendarEvent(calendar, dayData, fileUrl) {
  const calendarId = process.env.CALENDAR_ID || 'primary';

  // Build event date from dd/mm/yyyy
  const [dd, mm, yyyy] = dayData.date.split('/');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  // Check if event already exists for this day
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
      `• Shadowing: ${dayData.shadow.length} sentences · Pattern: ${dayData.shadow[0]?.pattern || ''}`,
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
        { method: 'popup', minutes: 0 }   // popup right at 6am
      ]
    },
    colorId: '7'  // peacock blue — matches ocean theme
  };

  if (existing.data.items.length > 0) {
    // Update existing event
    const eventId = existing.data.items[0].id;
    await calendar.events.update({
      calendarId,
      eventId,
      requestBody: eventBody
    });
    console.log(`Updated Calendar event for Day ${dayData.day}`);
  } else {
    // Create new event
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
    body: `Open your study file → ${fileUrl}`,
    headers: {
      'Title':    `🇯🇵 Day ${dayData.day} — Study time!`,
      'Priority': 'default',
      'Tags':     'japan,books'
    }
  });
  console.log('Push notification sent');
}

// ── Main ────────────────────────────────────────────────
async function run() {
  console.log('Starting JP Study generation...');

  const auth     = await getAuth();
  const sheets   = google.sheets({ version: 'v4', auth });
  const drive    = google.drive({ version: 'v3', auth });
  const calendar = google.calendar({ version: 'v3', auth });

  // Read all sheet tabs in parallel
  const [schedule, kanjiData, vocabData, podData, shadowData] = await Promise.all([
    getSheet(sheets, 'Schedule'),
    getSheet(sheets, 'n4_vocab'),
    getSheet(sheets, 'n4_kanji'),
    getSheet(sheets, 'japanese_podcast_kb'),
    getSheet(sheets, 'reiko_patterns_examples')
  ]);

  // Find today
  const { row, todayStr } = getTodayRow(schedule);
  if (!row) {
    console.log(`No schedule row found for ${todayStr} — nothing to do.`);
    process.exit(0);
  }

  console.log(`Found Day ${row.Day} for ${todayStr}`);

  // Build day data object
  const dayData = {
    day:     parseInt(row.Day),
    date:    row.Date,
    kanji:   lookup(kanjiData,  parseIds(row.N4_Kanji)),
    vocab:   lookup(vocabData,  parseIds(row.N4_vocab)),
    podcast: lookup(podData,   [row.N4_Podcast])[0] || {},
    shadow:  lookup(shadowData, parseIds(row.Reiko_shadow))
  };

  // Step 1 — save placeholder to Drive first to get the URL
  const placeholderHtml = `<html><body>Generating Day ${dayData.day}...</body></html>`;
  const fileUrl = await saveHtmlToDrive(drive, placeholderHtml, dayData.day);
  console.log(`Drive URL: ${fileUrl}`);

  // Step 2 — generate real HTML with Claude (passing fileUrl for self-reference)
  console.log('Calling Claude API...');
  const html = await generateHtml(dayData, fileUrl);
  console.log(`HTML generated: ${html.length} chars`);

  // Step 3 — update Drive file with real HTML
  await saveHtmlToDrive(drive, html, dayData.day);
  console.log('Drive file updated with real HTML');

  // Step 4 — create Google Calendar event
  await createCalendarEvent(calendar, dayData, fileUrl);

  // Step 5 — send push notification
  await sendNotification(dayData, fileUrl);

  console.log(`✓ Day ${dayData.day} complete → ${fileUrl}`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
