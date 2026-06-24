# Card Kaizoku → Discord Announcer

This checks the Card Kaizoku event calendar and posts newly-added events to a Discord channel using a webhook.

## Files

- `index.js` — scraper and Discord poster
- `.github/workflows/events.yml` — GitHub Actions schedule
- `data/seen-events.json` — created automatically to prevent duplicate posts

## Setup

1. Create a new GitHub repository.
2. Upload these files.
3. In Discord, create a webhook:
   - Server Settings
   - Integrations
   - Webhooks
   - New Webhook / Create Webhook
   - Pick the channel
   - Copy Webhook URL
4. In GitHub:
   - Repo Settings
   - Secrets and variables
   - Actions
   - New repository secret
   - Name: `DISCORD_WEBHOOK_URL`
   - Value: your Discord webhook URL
5. Go to the Actions tab and manually run **Card Kaizoku Discord Announcer** once.

By default, the first run saves the current events as a baseline and does not post everything. After that, new events should post automatically.

## Local test

```bash
npm install
npx playwright install chromium
DISCORD_WEBHOOK_URL="your webhook url here" node index.js
```

On Windows PowerShell:

```powershell
npm install
npx playwright install chromium
$env:DISCORD_WEBHOOK_URL="your webhook url here"
node index.js
```
