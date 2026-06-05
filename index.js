const Anthropic  = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs         = require('fs');

const SPREADSHEET_ID = '1_xf4eMikaE02-2ZLffLFD1qCKf1y3s5of_CNI3XipWs';

async function run() {

  // ── Auth ──────────────────────────────────────────────
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ]
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const drive  = google.drive({ version: 'v3', auth });

  // ── Read all sheet tabs ───────────────────────────────
  async function getSheet(name) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${name}!A:Z`
    });
    const [header, ...rows] = res.data.values;
    return rows.map(row =>
      Object.fromEntries(header.map((h, i) => [h.trim(), (row[i] || '').trim()]))
    );
  }

  const [schedule, kanjiData, vocabData, podData, shadowData] = await Promise.all([
    getSheet('Schedule'),
    getSheet('n4_kanji'),
    getSheet('n4_vocab'),
    getSheet('n4_podcast'),
    getSheet('n4_shadow')
  ]);

  // ── Find today ────────────────────────────────────────
  const now   = new Date();
  const dd    = String(now.getDate()).padStart(2, '0');
  const mm    = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy  = now.getFullYear();
  const today = `${dd}/${mm}/${yyyy}`;

  const row = schedule.find(r => r.Date === today);
  if (!row) { console.log(`No row for ${today}`); process.exit(0); }

  const parse  = str => str.split(',').map(s => s.trim()).filter(Boolean);
  const lookup = (data, ids) => ids.map(id => data.find(r => r.ID === id) || {});

  const dayData = {
    day:     parseInt(row.Day),
    date:    row.Date,
    kanji:   lookup(kanjiData,  parse(row.N4_Kanji)),
    vocab:   lookup(vocabData,  parse(row.N4_vocab)),
    podcast: lookup(podData,   [row.N4_Podcast])[0] || {},
    shadow:  lookup(shadowData, parse(row.Reiko_shadow))
  };

  // ── Call Claude ───────────────────────────────────────
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const html = await generateHtml(client, dayData);

  // ── Save to Google Drive ──────────────────────────────
  const fileName = `japanese_study_day${dayData.day}.html`;
  const existing = await drive.files.list({
    q: `name='${fileName}' and trashed=false`,
    fields: 'files(id, webViewLink)'
  });

  let fileId;
  const { Readable } = require('stream');
  const media = { mimeType: 'text/html', body: Readable.from([html]) };

  if (existing.data.files.length > 0) {
    fileId = existing.data.files[0].id;
    await drive.files.update({ fileId, media });
  } else {
    const created = await drive.files.create({
      requestBody: { name: fileName, mimeType: 'text/html' },
      media,
      fields: 'id'
    });
    fileId = created.data.id;
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' }
    });
  }

  const fileUrl = `https://drive.google.com/file/d/${fileId}/view`;
  console.log(`✓ Day ${dayData.day} ready → ${fileUrl}`);

  // ── Notify via ntfy ───────────────────────────────────
  await fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
    method: 'POST',
    body: `Open → ${fileUrl}`,
    headers: {
      'Title': `🇯🇵 Day ${dayData.day} — Study time!`,
      'Priority': 'default',
      'Tags': 'japan'
    }
  });
}

// ── HTML generator (same prompt as before) ────────────
async function generateHtml(client, dayData) {
  const msg = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: buildPrompt(dayData)
    }]
  });
  return msg.content[0].text;
}

function buildPrompt(d) {
  return `You are a Japanese study HTML renderer.
Generate a complete standalone HTML file for Day ${d.day} of 60 (date: ${d.date}).

Ocean Neumorphism theme:
- BG gradient: linear-gradient(145deg,#e8f4fd,#d0e8f5,#c8e0f0) fixed
- Blur orbs: top-right #2196f3 / bottom-left #26c6da
- Shadows out: 6px 6px 14px #a8c8e0,-6px -6px 14px #ffffff
- Shadows in: inset 4px 4px 10px #a8c8e0,inset -4px -4px 10px #ffffff
- Accent gradient: linear-gradient(135deg,#1a6fa8,#26c6da)
- Text: primary #0d2d4a / secondary #2e6080 / muted #6e9ab5

Sections (in order):
1. Header — Day ${d.day} of 60, date ${d.date}, progress bar ${((d.day/60)*100).toFixed(2)}%
2. Kanji cards — ${d.kanji.length} cards with char, meaning, on/kun readings, common words, example JP+EN
3. Vocabulary list — ${d.vocab.length} items with word, reading, meaning, JP sentence, EN sentence
4. Shadowing — 10 items with pattern label, JP sentence, hint, play button
5. Podcast — gradient banner, ep number, title, furigana, tags, reason tied to today vocab, 3 key phrases, open link
6. Speaking Drills — first 5 shadow sentences × 2 variations (casual + formal) with change notes
7. Completion — stat pills, Mark as Done button, localStorage key jpstudy_day${d.day}_done, ocean confetti

Mark as Done button must run this JS when clicked:
async function markDone() {
  // UI update + confetti first
  document.getElementById('doneBtn').classList.add('done');
  document.getElementById('doneBtn').innerHTML = '🌸 Day ${d.day} Complete!';
  document.getElementById('doneNote').textContent = 'Great work. See you tomorrow.';
  launchConfetti();
  localStorage.setItem('jpstudy_day${d.day}_done','true');
  // Then update Sheet
  await fetch('https://YOUR_CLOUD_RUN_URL/mark-done', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ day: ${d.day}, date: '${d.date}' })
  });
}

DATA:
KANJI: ${JSON.stringify(d.kanji)}
VOCAB: ${JSON.stringify(d.vocab)}
SHADOW: ${JSON.stringify(d.shadow)}
PODCAST: ${JSON.stringify(d.podcast)}

Output: raw HTML only. No markdown. No explanation.`;
}

run().catch(console.error);
