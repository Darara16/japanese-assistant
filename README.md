# 🇯🇵 Japanese Study System

Automated daily Japanese study file generator for N4 level.

## What it does
- Runs every day at 6am Vienna time
- Reads today's schedule from Google Sheets (N4 Progress)
- Calls Claude API to generate a full HTML study file
- Saves the file to Google Drive
- Creates a Google Calendar event with the link
- Sends a push notification via ntfy
- When you click "Mark as Done" → updates Sheet status + Calendar event

## Stack
- GitHub Actions (scheduler)
- Claude API (HTML generation)
- Google Sheets API (schedule + status)
- Google Drive API (file storage)
- Google Calendar API (daily event)
- ntfy.sh (push notifications)

## Secrets required
| Secret | Description |
|---|---|
| ANTHROPIC_API_KEY | Anthropic console |
| GOOGLE_CREDENTIALS | Google Cloud service account JSON |
| NTFY_TOPIC | Your ntfy channel name |
| CALENDAR_ID | Google Calendar ID |
| GITHUB_PAT | Personal access token with repo scope |

## Schedule
- 3 kanji · 12 vocabulary · 10 shadowing sentences · 1 podcast
- 60 days total · N4 level · June–August 2026
