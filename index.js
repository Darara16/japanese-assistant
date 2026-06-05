const Anthropic  = require('@anthropic-ai/sdk');
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

// ── Find a row by its ID column ─────────────────────────
function findById(data, id) {
  const clean = id.trim();
  return data.find(row =>
    Object.values(row).some((v, i) => i === 0 && v === clean)
  ) || null;
}

// ── Today as DD/MM/YYYY ─────────────────────────────────
function todayString() {
  const now  = new Date();
  const dd   = String(now.getDate()).padStart(2, '0');
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// ── Commit HTML to gh-pages branch ─────────────────────
async function saveHtmlToGitHub(html, dayNum) {
  const fileName = `japanese_study_day${dayNum}.html`;
  const repo     = process.env.GITHUB_REPOSITORY;
  const pat      = process.env.GITHUB_PAT;
  const branch   = 'gh-pages';
  const url      = `https://api.github.com/repos/${repo}/contents/${fileName}`;

  const headers = {
    'Authorization': `Bearer ${pat}`,
    'Content-Type':  'application/json',
    'Accept':        'application/vnd.github.v3+json'
  };

  // Get existing file SHA if it exists (required for updates)
  let sha;
  const check = await fetch(`${url}?ref=${branch}`, { headers });
  if (check.ok) {
    const existing = await check.json();
    sha = existing.sha;
  }

  const body = {
    message: `Add Day ${dayNum} study file`,
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

// ── Create Google Calendar event ────────────────────────
async function createCalendarEvent(calendar, dayData, fileUrl) {
  const calendarId = process.env.CALENDAR_ID || 'primary';
  const [dd, mm, yyyy] = dayData.date.split('/');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  const summary = `🇯🇵 Japanese Study — Day ${dayData.day} of 60`;

  // Check if event already exists
  const existing = await calendar.events.list({
    calendarId,
    timeMin: `${dateStr}T05:00:00Z`,
    timeMax: `${dateStr}T07:00:00Z`,
    q:       summary,
    singleEvents: true
  });

  const eventBody = {
    summary,
    description: [
      `Day ${dayData.day} of 60 · N4 · ${dayData.date}`,
      '',
      `Kanji:    ${dayData.kanji.map(k => k.kanji).join('  ')}`,
      `Vocab:    ${dayData.vocab.slice(0, 5).map(v => v.word).join(', ')} ...`,
      `Podcast:  ${dayData.podcast.title_jp || ''}`,
      '',
      `Study file: ${fileUrl}`
    ].join('\n'),
    start: { dateTime: `${dateStr}T06:00:00`, timeZone: 'Europe/Vienna' },
    end:   { dateTime: `${dateStr}T07:00:00`, timeZone: 'Europe/Vienna' },
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 0 }]
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
    await calendar.events.insert({
      calendarId,
      requestBody: eventBody
    });
    console.log('Calendar event created');
  }
}

// ── ntfy push notification ──────────────────────────────
async function sendNotification(day, fileUrl) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) { console.log('No NTFY_TOPIC set — skipping notification'); return; }

  await fetch(`https://ntfy.sh/${topic}`, {
    method:  'POST',
    body:    `Open → ${fileUrl}`,
    headers: {
      'Title':    `🇯🇵 Day ${day} — Study time!`,
      'Priority': 'default',
      'Tags':     'japan'
    }
  });
  console.log('Push notification sent');
}

// ── Build prompt for Claude ─────────────────────────────
function buildPrompt(d) {
  const repo = process.env.GITHUB_REPOSITORY || '';
  const pat  = process.env.GITHUB_PAT        || '';
  const pct  = ((d.day / 60) * 100).toFixed(2);

  return `You are a Japanese study HTML renderer.
Generate a complete standalone HTML file for Day ${d.day} of 60 (date: ${d.date}).

THEME — Ocean Neumorphism:
- Body background: linear-gradient(145deg,#e8f4fd,#d0e8f5,#c8e0f0) fixed
- Two decorative blur orbs (position:fixed, pointer-events:none, z-index:0, filter:blur(80px), opacity:0.25):
  top-right: 500px circle, radial-gradient #2196f3
  bottom-left: 400px circle, radial-gradient #26c6da
- Neumorphic shadow out: 6px 6px 14px #a8c8e0, -6px -6px 14px #ffffff
- Neumorphic shadow in:  inset 4px 4px 10px #a8c8e0, inset -4px -4px 10px #ffffff
- Card shadow: 8px 8px 22px #9fc0db, -8px -8px 22px #ffffff
- Accent gradient: linear-gradient(135deg,#1a6fa8,#26c6da)
- Background color for all elements: #daeaf7
- Text primary: #0d2d4a  secondary: #2e6080  muted: #6e9ab5  faint: #9bbdd0
- Border radius: 18px sections, 12px cards, 50px pills
- Max width: 900px centered

SECTIONS (render all 7 in this order):

1. HEADER
Pill row: gradient pill "Day ${d.day} of 60", plain pill "N4 · 2026", plain pill "${d.date}"
H1: Japanese Study <span gradient>日本語</span>
Subtitle: Daily session · Kanji · Vocabulary · Shadowing · Podcast
Progress bar: track is nm-in, fill is accent gradient at ${pct}%, labels Day ${d.day} / ${pct}% / Day 60

2. KANJI — ${d.kanji.length} cards in responsive grid (min 240px)
Each card (nm-out, hover nm-card):
  - Character 58px bold with text-shadow
  - Meaning: gradient text uppercase 11px
  - Reading pills (nm-press): on-reading, kun-reading
  - Common words: 12px muted
  - Example box (nm-in): JP sentence + EN translation italic

3. VOCABULARY — ${d.vocab.length} items
Each item (nm-out, 2-col grid 160px + 1fr):
  Left: word 18px bold, reading 12px muted
  Right: meaning gradient uppercase 12px, JP sentence 13px, EN sentence italic muted 11px

4. SHADOWING — 10 sentences
Each item (nm-out, flex row):
  Numbered circle (nm-out), pattern label gradient text 10px uppercase, JP sentence 16px bold, hint italic muted, gradient play button circle

5. PODCAST — single card
Gradient banner: thumb emoji box, episode label, JP title 16px bold white, furigana 12px white
Body: tag pills (nm-press), reason box (nm-in) tied to today vocab, 3 phrase rows (nm-out) with JP → EN, gradient open link button

6. SPEAKING DRILLS — first 5 shadowing sentences × 2 variations
Each drill (nm-out): original sentence, then 2 variations in nm-in boxes each with a badge (nm-out) labelled Casual/Formal/Written/Texting and change notes italic muted

7. COMPLETION
Stat pills (nm-out): ${d.kanji.length} kanji · ${d.vocab.length} vocab · 10 shadowing · 1 podcast
Mark as Done button (nm-card, large, 50px border-radius)
Done note text below button

JAVASCRIPT (include all of this exactly):

Scroll reveal:
const io = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.07 });
document.querySelectorAll('.section').forEach(s => io.observe(s));
All .section elements start: opacity:0; transform:translateY(20px); transition:opacity 0.55s ease,transform 0.55s ease;
.section.visible: opacity:1; transform:translateY(0);

Progress bar animate on load:
window.addEventListener('load', () => {
  setTimeout(() => { document.getElementById('progressFill').style.width = '${pct}%'; }, 500);
});

Ocean confetti (launchConfetti function):
140 pieces, colors ['#1a6fa8','#26c6da','#4fc3f7','#81d4fa','#b3e5fc','#ffffff','#e1f5fe']
Mix of circles and rect shapes, 200 frames animation then clear canvas
Canvas is position:fixed top:0 left:0 width:100% height:100% pointer-events:none z-index:999

Mark as Done:
async function markDone() {
  const btn = document.getElementById('doneBtn');
  const note = document.getElementById('doneNote');
  if (btn.classList.contains('done')) return;
  btn.classList.add('done');
  btn.innerHTML = '🌸 &nbsp; Day ${d.day} Complete!';
  btn.style.background = 'linear-gradient(135deg,#1a6fa8,#26c6da)';
  btn.style.color = '#fff';
  btn.style.boxShadow = '0 6px 22px rgba(26,111,168,0.40)';
  note.textContent = 'Great work. See you tomorrow for Day ${d.day + 1}.';
  launchConfetti();
  try { localStorage.setItem('jpstudy_day${d.day}_done', 'true'); } catch(e) {}
  try {
    await fetch('https://api.github.com/repos/${repo}/dispatches', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ${pat}', 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json' },
      body: JSON.stringify({ event_type: 'mark-done', client_payload: { day: ${d.day}, date: '${d.date}' } })
    });
  } catch(e) { console.log('Status update failed:', e); }
}

Restore on load:
try {
  if (localStorage.getItem('jpstudy_day${d.day}_done') === 'true') {
    const btn = document.getElementById('doneBtn');
    btn.classList.add('done');
    btn.innerHTML = '🌸 &nbsp; Day ${d.day} Complete!';
    btn.style.background = 'linear-gradient(135deg,#1a6fa8,#26c6da)';
    btn.style.color = '#fff';
    document.getElementById('doneNote').textContent = 'Great work. See you tomorrow for Day ${d.day + 1}.';
  }
} catch(e) {}

TODAY'S DATA — render exactly this content, do not invent or change any Japanese:

KANJI (${d.kanji.length} items):
${JSON.stringify(d.kanji, null, 2)}

VOCABULARY (${d.vocab.length} items):
${JSON.stringify(d.vocab, null, 2)}

SHADOWING (${d.shadow.length} items):
${JSON.stringify(d.shadow, null, 2)}

PODCAST:
${JSON.stringify(d.podcast, null, 2)}

Output: raw HTML only. No markdown. No code fences. Start with <!DOCTYPE html>.`;
}

// ── Call Claude API ─────────────────────────────────────
async function generateHtml(dayData) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model:      'claude-opus-4-5',
    max_tokens: 16000,
    messages:   [{ role: 'user', content: buildPrompt(dayData) }]
  });
  return msg.content[0].text;
}

// ── MAIN ────────────────────────────────────────────────
async function run() {
  console.log('Starting JP Study generation...');

  const auth     = await getAuth();
  const sheets   = google.sheets({ version: 'v4', auth });
  const calendar = google.calendar({ version: 'v3', auth });

  // Load all 5 sheets — exact tab names from your spreadsheet
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

  // Parse IDs from schedule row
  const kanjiIds   = row.N4_Kanji.split(',').map(s => s.trim()).filter(Boolean);
  const vocabIds   = row.N4_vocab.split(',').map(s => s.trim()).filter(Boolean);
  const podcastId  = row.N4_Podcast.trim();
  const shadowIds  = row.Reiko_shadow.split(',').map(s => s.trim()).filter(Boolean);

  // Lookup rows by ID (first column)
  const kanji   = kanjiIds.map(id   => kanjiSheet.find(r   => Object.values(r)[0] === id) || {});
  const vocab   = vocabIds.map(id   => vocabSheet.find(r   => Object.values(r)[0] === id) || {});
  const podcast = podcastSheet.find(r => Object.values(r)[0] === podcastId) || {};
  const shadow  = shadowIds.map(id  => shadowSheet.find(r  => Object.values(r)[0] === id) || {});

  console.log(`Resolved — kanji:${kanji.length} vocab:${vocab.length} shadow:${shadow.length} podcast:${podcast[Object.keys(podcast)[0]] || 'NOT FOUND'}`);

  const dayData = {
    day: parseInt(row.Day),
    date: today,
    kanji,
    vocab,
    podcast,
    shadow
  };

  // Generate HTML
  console.log('Calling Claude API...');
  const html = await generateHtml(dayData);
  console.log(`HTML generated: ${html.length} chars`);

  // Commit to gh-pages
  const fileUrl = await saveHtmlToGitHub(html, dayData.day);
  console.log(`Published: ${fileUrl}`);

  // Calendar event
  await createCalendarEvent(calendar, dayData, fileUrl);

  // Push notification
  await sendNotification(dayData.day, fileUrl);

  console.log(`\n✓ Done → ${fileUrl}`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
