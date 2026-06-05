const { google } = require('googleapis');

const SPREADSHEET_ID = '1_xf4eMikaE02-2ZLffLFD1qCKf1y3s5of_CNI3XipWs';

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

async function run() {
  const day  = parseInt(process.env.DAY);
  const date = process.env.DATE;

  if (!day) {
    console.error('DAY env variable required');
    process.exit(1);
  }

  const auth     = await getAuth();
  const sheets   = google.sheets({ version: 'v4', auth });
  const calendar = google.calendar({ version: 'v3', auth });

  // ── Update Sheet status ─────────────────────────────
  const sheetRow = day + 1; // row 1 = header, row 2 = day 1

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Schedule!G${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['TRUE']] }
  });

  console.log(`✓ Sheet: Day ${day} status → TRUE`);

  // ── Update Calendar event — add ✅ to title ──────────
  const calendarId = process.env.CALENDAR_ID || 'primary';
  const [dd, mm, yyyy] = date.split('/');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  const existing = await calendar.events.list({
    calendarId,
    timeMin: `${dateStr}T05:00:00Z`,
    timeMax: `${dateStr}T07:00:00Z`,
    q: `Japanese Study Day ${day}`,
    singleEvents: true
  });

  if (existing.data.items.length > 0) {
    const event   = existing.data.items[0];
    const eventId = event.id;

    await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: {
        summary:  `✅ Japanese Study — Day ${day} of 60`,
        colorId:  '2'  // sage green — done
      }
    });

    console.log(`✓ Calendar: Day ${day} event marked ✅ green`);
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
