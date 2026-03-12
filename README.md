# Dialpad → Less Annoying CRM Webhook

Node.js service that receives Dialpad call webhooks and syncs call data into Less Annoying CRM: finds or creates a contact by phone number and adds a call note with type, transcript URL, and recording URL.

## Features

- **Webhook endpoint**: `POST /dialpad-webhook` for Dialpad call events (v2 API: ringing, connected, hangup, recording, call_transcription, etc.)
- **CRM flow**: Search contact by phone → create if not found → add call note
- **File logging**: Console + `logs/webhook.log`
- **Retry**: Automatic retries for CRM API calls (exponential backoff)
- **Phone normalization**: E.164 via `libphonenumber-js` (default country US)
- **Duplicate handling**: When multiple contacts match, prefers exact phone match

## Setup

### 1. Install dependencies

```bash
cd dialpad-crm
npm install
```

### 2. Environment variables

Copy the example env file and set your CRM credentials:

```bash
copy .env.example .env
```

Edit `.env`:

```
CRM_API_KEY=your_crm_api_key
CRM_USER_CODE=your_user_code
CRM_ASSIGNED_TO=123456
PORT=3000
```

- **CRM_API_KEY** / **CRM_USER_CODE**: Less Annoying CRM → **Settings → Programmer API** (create a key with permissions for contacts and notes). For the v2 API (default), only `CRM_API_KEY` is used (in the Authorization header).
- **CRM_ASSIGNED_TO**: LAC User ID that new contacts will be assigned to (required when creating contacts). Find your User ID in LAC under **Settings → Users** (must be a User ID your API key is allowed to assign to).
- **CRM_API_VERSION**: Optional. `v2` (default) = POST to `/v2/` with `Authorization: CRM_API_KEY`. `v1` = legacy body auth with `UserCode` and `APIToken`.

### 3. Run the server

```bash
npm start
```

Server listens on `http://0.0.0.0:3000` (or the port in `PORT`).

## Deploy to VPS (31.220.94.61)

Once the app is on your VPS with `.env` configured (including `PUBLIC_WEBHOOK_URL=http://31.220.94.61:3000`):

### 1. Open firewall (so Dialpad can reach the webhook)

```bash
# Ubuntu/Debian with ufw
sudo ufw allow 3000/tcp
sudo ufw status
sudo ufw enable   # if not already enabled
```

### 2. Run with PM2 (restart on crash and reboot)

```bash
npm install -g pm2
pm2 start server.js --name dialpad-crm-webhook
pm2 save
pm2 startup   # run the command it prints to enable on boot
```

### 3. Register the webhook with Dialpad (one-time)

From the project root (on the VPS or from your machine with the same `.env`):

```bash
node scripts/register-dialpad-webhook.js
```

IDs are saved to `dialpad-webhook-ids.json`.

### 4. Verify

- Health: `curl http://31.220.94.61:3000/health`
- Make a test call in Dialpad, then check `logs/webhook.log` and the CRM for the new note.

### 5. Dialpad requires HTTPS

Dialpad’s API rejects `http://` webhook URLs. To finish registration you need either:

- **Option A:** A domain pointing at this VPS, then Nginx (or Caddy) + Let’s Encrypt, and set `PUBLIC_WEBHOOK_URL=https://your-domain.com` before running `node scripts/register-dialpad-webhook.js`.
- **Option B:** A tunnel (e.g. ngrok) with an `https://` URL; set `PUBLIC_WEBHOOK_URL` to that URL and run the registration script.

### 6. PM2 on reboot

Run the command that `pm2 startup` printed (with `sudo`) so the app restarts on reboot. Example:

```bash
sudo env PATH=$PATH:/home/odmin/.nvm/versions/node/v22.21.1/bin /home/odmin/.nvm/versions/node/v22.21.1/lib/node_modules/pm2/bin/pm2 startup systemd -u odmin --hp /home/odmin
```

## Dialpad webhook configuration (API v2)

Dialpad does not expose webhook creation in the dashboard; you register the endpoint and subscribe to call events via the API.

### Prerequisites

- **Company admin** in Dialpad.
- **API key**: Dialpad → Admin Settings (gear) → My Company → Authentication → API Keys. Create a key with at least `recordings_export` (and `message_content_export` if needed). Copy the key (it is shown only once).
- **Public URL** for this server (e.g. `https://your-domain.com` or an ngrok URL for local testing). The server must respond with **HTTP 200** within a few seconds.

### Option A: Use the registration script (recommended)

1. In `.env`, set:
   - `PUBLIC_WEBHOOK_URL` = your public base URL (e.g. `https://your-server.com` or `https://xxxx.ngrok.io`). The script will append `/dialpad-webhook`.
   - `DIALPAD_API_KEY` = your Dialpad API key.
   - (Optional) `DIALPAD_WEBHOOK_SECRET` = a secret string; if set, Dialpad will sign payloads with HS256 JWT and the server will verify them.

2. From the project root, run:

   ```bash
   node scripts/register-dialpad-webhook.js
   ```

   This creates the webhook and subscribes to call events (`connected`, `hangup`, `recording`, `call_transcription`) for the whole company. Save the printed `webhook_id` if you need to delete or list webhooks later.

### Option B: Manual API calls

1. **Create webhook** (tells Dialpad where to send events):

   ```bash
   curl -X POST https://dialpad.com/api/v2/webhooks \
     -H "Authorization: Bearer YOUR_DIALPAD_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://your-server.com/dialpad-webhook", "secret": "your-optional-secret"}'
   ```

   Save the returned `id` (webhook_id).

2. **Subscribe to call events**:

   ```bash
   curl -X POST https://dialpad.com/api/v2/subscriptions/call \
     -H "Authorization: Bearer YOUR_DIALPAD_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"webhook_id": WEBHOOK_ID_FROM_STEP_1, "call_states": ["connected","hangup","recording","call_transcription"], "target_type": "company"}'
   ```

### Management

- List webhooks: `GET https://dialpad.com/api/v2/webhooks` (with `Authorization: Bearer YOUR_API_KEY`).
- List subscriptions: `GET https://dialpad.com/api/v2/subscriptions/call`.
- Delete webhook: `DELETE https://dialpad.com/api/v2/webhooks/{webhook_id}`.
- Delete subscription: `DELETE https://dialpad.com/api/v2/subscriptions/call/{subscription_id}`.

### Verify and test

Make a test call in Dialpad and check your server logs (`logs/webhook.log`) and CRM. The server only creates CRM notes for “final” events (`hangup`, `recording`, `call_transcription`, `recap_summary`) to avoid duplicate notes; other states (e.g. `ringing`, `connected`) are acknowledged with 200 but not written to the CRM.

## Endpoints

| Method | Path               | Description                    |
|--------|--------------------|--------------------------------|
| GET    | /health            | Health check (returns 200 OK)  |
| POST   | /dialpad-webhook   | Dialpad call.completed webhook |

## Expected flow

1. A call completes in Dialpad.
2. Dialpad sends `POST` to `/dialpad-webhook` with call payload.
3. Server normalizes the phone number, searches Less Annoying CRM.
4. If no contact exists, it creates one with that phone.
5. It adds a note to the contact with call type, transcript URL, and recording URL.
6. Server responds `200 OK` to Dialpad.

## Testing the CRM connection

Run the standalone CRM test script (uses `.env` credentials):

```bash
node test-crm-api.js
```

Optional: pass a phone number to search for: `node test-crm-api.js +61475410214`

This tests **GetContacts**, then (if `CRM_ASSIGNED_TO` is set) **CreateContact** and **CreateNote**. If you see "You do not have permission to assign contacts to UserId X", set `CRM_ASSIGNED_TO` to your actual LAC User ID from **Settings → Users**.

## Testing locally

Send a test payload (adjust phone and URLs as needed):

```bash
curl -X POST http://localhost:3000/dialpad-webhook -H "Content-Type: application/json" -d "{\"from_number\":\"+15551234567\",\"direction\":\"inbound\",\"transcript_url\":\"https://example.com/transcript\",\"recording_url\":\"https://example.com/recording\"}"
```

Check `logs/webhook.log` and your CRM for the new or updated contact and note.

## Logs

- Console: structured messages for each request and errors.
- File: `logs/webhook.log` (created automatically; same events in JSON form).

## Potential issues and notes

- **Webhook authentication**: If you set `DIALPAD_WEBHOOK_SECRET` when creating the webhook, Dialpad signs payloads with HS256 JWT and the server verifies them; unverified requests receive 401.
- **Duplicate notes**: The server only creates CRM notes for final events (hangup, recording, call_transcription, recap_summary). If Dialpad retries the same event, you may still get duplicates; optional improvement: store `call_id` and skip or dedupe by it.
- **JWT payloads**: When `DIALPAD_WEBHOOK_SECRET` is set, the server expects and verifies JWT-signed bodies (HS256).
- **International numbers**: Phone normalization defaults to US (`+1`). Set or extend logic if you need other default country codes.

## License

MIT
