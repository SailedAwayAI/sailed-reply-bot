# Sailed Away AI Reply Bot

A small standalone app on Vercel that answers lead replies for every client. It is separate from the client dashboard on purpose: dashboard changes cannot break it, and it does exactly one job.

## How it works

1. A lead replies. Instantly calls `POST /api/instantly?client=<clientId>&secret=<WEBHOOK_SECRET>` (event `reply_received` only).
2. The bot claims that reply id in Redis. A reply is handled once, ever, even if Instantly sends it twice.
3. It reads the client's Brain and settings from the dashboard (read only).
4. Quick checks skip it without calling Claude: campaign switched off, lead is Lost / Not interested / Won, empty reply, or a reply older than 48 hours (protects against old events being fired again).
5. Claude drafts a reply using only the Brain, and classifies the reply. Out of office, unsubscribe, rejections and wrong person get no reply.
6. Decision:
   * **Auto campaign:** sends through Instantly in the same thread, logs it in the dashboard as "Sent automatically by reply bot".
   * **Manual campaign:** saves the draft to the dashboard Unibox and posts one agency Slack notice with a link to the conversation. Nothing sends until someone reviews it.
   * Auto falls back to review when: the global switch is off, the daily cap is hit (default 25 per client), or the draft needed a fact that is not in the Brain.

## Safety switches

* `TEST_MODE` is on unless set to exactly `off`. In test mode the bot runs side by side with the dashboard's own reply bot: it drafts, posts what it would have done to the agency Slack channel, writes a log entry, and never sends or puts a draft into Unibox.

* `SENDING_ENABLED` must be exactly `on` for anything to be sent. Leave it off for the first days: every reply becomes a review draft.
* Every campaign starts as Manual in the dashboard.
* Only one system may reply. Before turning sending on, turn off the dashboard's built in reply bot sending and remove the old ReplyBot and n8n webhooks in Instantly.

## Setup (Christian)

1. Create an empty GitHub repo `SailedAwayAI/sailed-reply-bot`; the code gets pushed there.
2. In Vercel: Add New Project, import that repo. No build settings needed.
3. In Vercel, Storage: add Upstash Redis (Marketplace) and connect it to the project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
4. In Vercel, Settings, Environment Variables, add (you type these, never paste keys into chat):
   * `ANTHROPIC_API_KEY`
   * `WEBHOOK_SECRET` (any long random string)
   * `DASHBOARD_URL` = `https://dash.sailedawayai.com`
   * `DASHBOARD_BOT_TOKEN` (the same token the dashboard is given)
   * `INSTANTLY_KEYS_JSON` = `{"foundey":"<key>","marketsparx":"<key>", ...}` (client id to that client's Instantly API key)
   * `AGENCY_SLACK_WEBHOOK_URL` (agency channel incoming webhook)
   * `SENDING_ENABLED` = `off`
   * optional `CLAUDE_MODEL` (default `claude-sonnet-5-5`)
5. Deploy. Open `https://<app>.vercel.app/api/instantly` and it should say "reply bot is running".
6. In each client's Instantly workspace, add one webhook: event Reply received, URL above with that client's id and the secret.

## Dashboard contract (built in the client dashboard)

Both endpoints require `Authorization: Bearer <DASHBOARD_BOT_TOKEN>`.

`GET /api/bot/clients/:clientId/context?lead_email=&campaign_id=&email_id=` returns:

```json
{
  "clientId": "foundey",
  "clientName": "Foundey",
  "campaigns": { "<instantly campaign id>": { "mode": "auto|manual|off", "name": "..." } },
  "defaultMode": "manual",
  "bookingMode": "auto_book|calendar_link",
  "bookingLink": "https://...",
  "dailyAutoCap": 25,
  "brain": [{ "title": "...", "tag": "product information", "text": "..." }],
  "replyGuidelines": "optional",
  "senderName": "optional",
  "leadStatus": "Interested",
  "uniboxUrl": "https://dash.sailedawayai.com/unibox/...",
  "thread": [{ "from": "lead|us", "text": "...", "at": "ISO date" }]
}
```

`POST /api/bot/clients/:clientId/events` with `{ type: "draft"|"sent"|"skipped"|"error", emailId, leadEmail, campaignId, body, reason }`. The dashboard shows drafts in Unibox for review, marks sent replies, and never posts its own Slack alert for these (the bot already notified the agency).

## Rollout

1. Deploy with `SENDING_ENABLED=off`. Point one client's webhook at the bot. Compare its drafts with what you would send for a few days.
2. Remove old ReplyBot and n8n webhooks for that client, turn off the dashboard's own reply sending for that client.
3. Set `SENDING_ENABLED=on`, switch one campaign to Auto, watch the daily log.
4. Add the other clients one by one.

## Development

```
npm install
npm run typecheck
npm test
```
