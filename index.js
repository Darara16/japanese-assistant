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
  const summary = `🇯🇵 Japanese Study — Day ${dayData.day} of 60`;

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
  if (!topic) { console.log('No NTFY_TOPIC — skipping'); return; }
  await fetch(`https://ntfy.sh/${topic}`, {
    method:  'POST',
    body:    `Open → ${fileUrl}`,
    headers: {
      'Title':    `Day ${day} — Study time!`,
      'Priority': 'default',
      'Tags':     'japan'
    }
  });
  console.log('Push notification sent');
}

// ── Build prompt for OpenAI ─────────────────────────────
function buildPrompt(d) {
  const pct = ((d.day / 60) * 100).toFixed(2);

  // NOTE: no PAT or secrets in the HTML — markDone only updates UI + localStorage
  return `You are a Japanese study HTML renderer.
Generate a complete standalone HTML file for Day ${d.day} of 60 (date: ${d.date}).

THEME — Ocean Neumorphism:
- Body background: linear-gradient(145deg,#e8f4fd,#d0e8f5,#c8e0f0) fixed
- Two decorative blur orbs (position:fixed, pointer-events:none, z-index:0, filter:blur(80px), opacity:0.25):
  top-right 500px circle radial-gradient(circle, #2196f3, transparent)
  bottom-left 400px circle radial-gradient(circle, #26c6da, transparent)
- Neumorphic shadow out: 6px 6px 14px #a8c8e0,-6px -6px 14px #ffffff
- Neumorphic shadow in: inset 4px 4px 10px #a8c8e0,inset -4px -4px 10px #ffffff
- Card shadow: 8px 8px 22px #9fc0db,-8px -8px 22px #ffffff
- Accent gradient: linear-gradient(135deg,#1a6fa8,#26c6da)
- Base background color: #daeaf7
- Text: primary #0d2d4a / secondary #2e6080 / muted #6e9ab5 / faint #9bbdd0
- Border radius: 18px sections, 12px cards, 50px pills
- Max width 900px centered, body padding 36px 16px 100px

SECTIONS (render all 7 in order):

1. HEADER
- Pill row: gradient pill "Day ${d.day} of 60", plain pill "N4 · 2026", plain pill "${d.date}"
- H1: Japanese Study <span with gradient clip text>日本語</span>
- Subtitle: Daily session · Kanji · Vocabulary · Shadowing · Podcast
- Progress bar: nm-in track, accent gradient fill animated to ${pct}% on load, labels "Day ${d.day}" left / "${pct}%" center / "Day 60" right

2. KANJI — ${d.kanji.length} cards in responsive grid (auto-fit minmax 240px)
Each card (nm-out shadow, hover nm-card): kanji character 58px bold text-shadow, meaning gradient uppercase 11px, on/kun reading pills (nm-press inset shadow), common words 12px muted, example box (nm-in) with JP sentence + EN translation italic muted

3. VOCABULARY — ${d.vocab.length} items
Each item (nm-out, 2-col grid 160px + 1fr, hover nm-card): word 18px bold + reading 12px muted left col, meaning gradient uppercase 12px + JP sentence 13px + EN sentence italic muted 11px right col

4. SHADOWING — 10 sentences
Each item (nm-out flex row, hover nm-card, active nm-press): numbered circle (nm-out, accent color number), grammar pattern label gradient uppercase 10px, JP sentence 16px bold, English hint italic muted 11px, gradient play button circle (decorative, no audio)

5. PODCAST — single card (nm-out)
Gradient banner: emoji thumb box, episode label white 10px uppercase, JP title white 16px bold, furigana white 12px
Body: tag pills (nm-press), reason box (nm-in) mentioning today vocab connection, 3 key phrase rows (nm-out) JP arrow EN, gradient "▶ Open Episode" link button (opens url in new tab)

6. SPEAKING DRILLS — first 5 shadowing sentences × 2 variations each
Each drill (nm-out): original label + sentence, then 2 variation rows (nm-in) each with badge pill (nm-out, accent text) Casual/Formal/Written/Texting and change notes italic muted 11px

7. COMPLETION
Stat pills row (nm-out each): ${d.kanji.length} kanji · ${d.vocab.length} vocab · 10 shadowing · 1 podcast
Large Mark as Done button (nm-card shadow, border-radius 50px, padding 17px 52px)
Done note paragraph below in muted text

JAVASCRIPT — include exactly this:

// Scroll reveal
const io = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.07 });
document.querySelectorAll('.section').forEach(s => io.observe(s));

// Progress bar on load
window.addEventListener('load', () => {
  setTimeout(() => { document.getElementById('progressFill').style.width = '${pct}%'; }, 500);
});

// Ocean confetti
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

// Mark as Done — UI only, no external calls
function markDone() {
  const btn = document.getElementById('doneBtn');
  const note = document.getElementById('doneNote');
  if (btn.classList.contains('done')) return;
  btn.classList.add('done');
  btn.innerHTML = ' &nbsp; Day ${d.day} Complete!';
  btn.style.background = 'linear-gradient(135deg,#1a6fa8,#26c6da)';
  btn.style.color = '#fff';
  btn.style.boxShadow = '0 6px 22px rgba(26,111,168,0.40)';
  note.textContent = 'Great work. See you tomorrow for Day ${d.day + 1}.';
  launchConfetti();
  try { localStorage.setItem('jpstudy_day${d.day}_done','true'); } catch(e) {}
}

// Restore on load
try {
  if (localStorage.getItem('jpstudy_day${d.day}_done')==='true') {
    const btn=document.getElementById('doneBtn');
    btn.classList.add('done');
    btn.innerHTML=' &nbsp; Day ${d.day} Complete!';
    btn.style.background='linear-gradient(135deg,#1a6fa8,#26c6da)';
    btn.style.color='#fff';
    btn.style.boxShadow='0 6px 22px rgba(26,111,168,0.40)';
    document.getElementById('doneNote').textContent='Great work. See you tomorrow for Day ${d.day + 1}.';
  }
} catch(e) {}

TODAY'S DATA — render exactly this content, do not invent or modify any Japanese text:

KANJI:
${JSON.stringify(d.kanji, null, 2)}

VOCABULARY:
${JSON.stringify(d.vocab, null, 2)}

SHADOWING:
${JSON.stringify(d.shadow, null, 2)}

PODCAST:
${JSON.stringify(d.podcast, null, 2)}

Output: raw HTML only. No markdown. No code fences. Start with <!DOCTYPE html>.`;
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
