# Cloudflare Worker — Setup, Architecture, and Dev Workflow

This document explains what the Cloudflare Worker does, how it was set up, and
how to make changes and redeploy. Written for someone who is new to Cloudflare
and wants to be self-sufficient in maintaining it.

---

## What Problem It Solves

Bay Club opens court booking windows exactly 3 days in advance, at the minute of
the slot. The browser extension lets you schedule a locked (not-yet-open) slot in
advance. When the window opens, *something* needs to fire the Bay Club booking API
at the right moment — even if your browser is closed.

That "something" is this Cloudflare Worker. It runs in Cloudflare's cloud,
independent of your browser, and fires automatically when it's time.

---

## How the Pieces Fit Together

```
Browser extension (bayclubconnect.com)
  │
  │  POST /bookings — "schedule this for me"
  │  DELETE /bookings/{id} — "cancel this"
  │  GET /bookings — "what's scheduled?"
  │  PUT /token — "here's a fresh refresh token"
  ▼
Cloudflare Worker  ←── cron fires every minute
  │                      checks: any bookings due now?
  │
  ├── Bay Club auth API — exchange refresh token for access token
  ├── Bay Club court booking API — POST + PUT to place the booking
  └── Resend email API — send success/failure email to user
```

The Worker stores everything in **Cloudflare KV** — a simple key/value store that
persists between cron runs and HTTP requests.

---

## Files

```
cloudflare-worker/
  worker.js       — all Worker logic: HTTP endpoints, cron tick, auth, booking, email
  wrangler.toml   — Wrangler config: Worker name, KV binding, cron schedule
  .gitignore      — excludes .wrangler/ local dev cache from git
```

`wrangler.toml` is the config file Wrangler (the Cloudflare CLI) reads when you
deploy. It declares:
- The Worker name (`bayclubconnect-bookings`)
- Which KV namespace to bind (under the name `BC_BOOKINGS`)
- The cron schedule (`* * * * *` = every minute)

---

## KV Storage

The KV namespace is named **BC_BOOKINGS** in code (bound in `wrangler.toml`) and
has the Cloudflare ID `299d14645bed49458addc9751cc6c241`. It holds three keys:

| Key | What it stores |
|-----|---------------|
| `refresh_token` | Current valid Bay Club refresh token. **Single-use** — the Worker rotates it on every use. |
| `scheduled_bookings` | JSON array of all booking records (pending, fired, failed, cancelled). |
| `last_token_refresh` | ISO timestamp of the last successful token rotation. Visible on `/status` as a sanity check. |

---

## Secrets

Secrets are sensitive values that must not be stored in `wrangler.toml` or
committed to git. They are set once via the Wrangler CLI and stored encrypted in
Cloudflare.

| Secret name | What it is | How to set |
|-------------|-----------|-----------|
| `WORKER_SECRET` | Shared secret the extension includes in its requests to authenticate itself (`X-Worker-Secret` header). | `wrangler secret put WORKER_SECRET` |
| `RESEND_API_KEY` | API key for the Resend email service. | `wrangler secret put RESEND_API_KEY` |

To view which secrets are currently set (without revealing values):

```
wrangler secret list
```

---

## HTTP Endpoints

All requests must be made from `https://bayclubconnect.com` (CORS is locked to
that origin).

| Method + Path | Auth required | Purpose |
|---------------|--------------|---------|
| `GET /status` | No | Health check. Returns pending booking count, next fire time, last token refresh timestamp, and full booking list. Useful for debugging. |
| `GET /bookings` | Yes | Returns the full bookings array. Used by the extension to sync its local cache. |
| `POST /bookings` | Yes | Adds a booking record. Called when user clicks Schedule. |
| `DELETE /bookings/{id}` | Yes | Removes a booking. Called on Cancel or Dismiss. |
| `PUT /token` | Yes | Stores a new refresh token in KV. Called automatically by the extension whenever it sees the Bay Club app renew its token. |

"Auth required" means the request must include the `X-Worker-Secret` header with
the value of the `WORKER_SECRET` secret.

---

## The Refresh Token Situation

Bay Club uses OAuth2 with **single-use refresh tokens** — each time you exchange a
refresh token for an access token, the old token is invalidated and a new one is
returned. This means:

1. The Worker must rotate the token in KV immediately after every use.
2. If the Worker ever fails to store the new token (e.g. a crash mid-flight), the
   chain is broken and the next booking attempt will fail with "No refresh token
   stored in KV."

**How the token stays fresh**: The extension monitors the Bay Club app's auth
token storage (`connect20auth` in localStorage). On every page load it reads the
stored refresh token and sends it to the Worker via `PUT /token`. This keeps the
Worker's token perpetually up to date as long as you log into bayclubconnect.com
occasionally.

**If the token chain breaks** (Worker fails to store, or Bay Club invalidates all
refresh tokens, or you haven't logged in for a long time): you need to bootstrap
a fresh token manually. See the Troubleshooting section below.

---

## Resend (Email Notifications)

[Resend](https://resend.com) is a transactional email service. The Worker uses it
to send a success or failure email after each booking attempt.

- **Sender address**: `notifications@bayclubhelper.app`
- **Domain**: `bayclubhelper.app` — purchased via Cloudflare Registrar, verified
  with Resend automatically (Cloudflare sets the required DNS records)
- **API key**: stored as the `RESEND_API_KEY` Wrangler secret
- **Recipient**: the `notificationEmail` field stored in each booking record
  (fetched from the Bay Club profile API when the user schedules the booking)

If you ever need to re-verify the domain or rotate the API key, log into
[resend.com](https://resend.com), go to Domains and API Keys respectively, and
then update the Wrangler secret: `wrangler secret put RESEND_API_KEY`.

---

## Day-to-Day Dev Workflow

### Prerequisites

```bash
npm install -g wrangler   # install the Cloudflare CLI (one time)
wrangler login            # authenticate with your Cloudflare account (one time)
```

### Making a Code Change

1. Edit `cloudflare-worker/worker.js`.
2. (Optional) Test locally:
   ```bash
   cd cloudflare-worker
   wrangler dev
   ```
   This runs the Worker at `http://localhost:8787` using miniflare (a local
   Cloudflare simulator). The cron trigger does not fire automatically in local
   dev — you can trigger it manually at `http://localhost:8787/__scheduled`.
   Note: local dev uses a local simulated KV, not the real Cloudflare KV, so
   data you write locally won't affect production.

3. Deploy to production:
   ```bash
   cd cloudflare-worker
   wrangler deploy
   ```
   This uploads `worker.js` and updates the live Worker. Takes about 5 seconds.
   No build step needed — Wrangler uploads the file as-is.

4. Verify the deployment worked:
   ```bash
   curl https://bayclubconnect-bookings.mark-rubin.workers.dev/status
   ```

### Changing the Cron Schedule

Edit the `crons` line in `wrangler.toml`, then redeploy. The current schedule
`* * * * *` means "every minute." Cloudflare Workers cron syntax is standard
cron but with a minimum granularity of one minute.

### Changing or Rotating Secrets

```bash
cd cloudflare-worker
wrangler secret put WORKER_SECRET   # prompts for new value
wrangler secret put RESEND_API_KEY
```

After rotating `WORKER_SECRET` you must also update the `WORKER_SECRET` constant
in `loading_script.user.js` (search for it near the top of
`getScheduledBookingService`) and reinstall the Tampermonkey script.

---

## Troubleshooting

### Check current state

```bash
curl https://bayclubconnect-bookings.mark-rubin.workers.dev/status
```

Returns `lastTokenRefresh` (when the token was last rotated), `pendingBookings`
count, `nextFireAt`, and the full booking list.

### "No refresh token stored in KV"

The refresh token chain is broken. Bootstrap a new one:

1. Log into bayclubconnect.com in your browser.
2. Open DevTools → Application → Local Storage → `https://bayclubconnect.com`.
3. Find the `connect20auth` key. Click it and copy the value.
4. Paste it into a text editor, find the `"refresh_token"` field, and copy just
   that token string.
5. Run:
   ```bash
   cd cloudflare-worker
   wrangler kv key put --binding BC_BOOKINGS refresh_token "<paste token here>"
   ```
6. Verify with `curl .../status` — `lastTokenRefresh` should update on the next
   page load (the extension sends the token to the Worker on startup).

Alternatively: simply reload bayclubconnect.com with the extension active. The
extension reads `connect20auth` on page load and automatically pushes the refresh
token to the Worker via `PUT /token`. Check `/status` after the page loads to
confirm `lastTokenRefresh` updated.

### View Worker logs

```bash
cd cloudflare-worker
wrangler tail
```

Streams live log output from the deployed Worker. Useful for watching a cron
tick fire in real time.

### Inspect or edit KV directly

```bash
# Read the full bookings list
wrangler kv key get --binding BC_BOOKINGS scheduled_bookings

# Read the current refresh token (to confirm it's present)
wrangler kv key get --binding BC_BOOKINGS refresh_token

# Manually write a value
wrangler kv key put --binding BC_BOOKINGS refresh_token "<token>"

# Delete a value
wrangler kv key delete --binding BC_BOOKINGS scheduled_bookings
```

---

## Cloudflare Dashboard

Everything above can also be inspected visually at
[dash.cloudflare.com](https://dash.cloudflare.com):

- **Workers & Pages** → `bayclubconnect-bookings` → view deployments, settings,
  cron triggers, and real-time logs
- **Workers & Pages** → KV → `BC_BOOKINGS` → browse and edit key/value pairs
  directly in the browser
- **Workers & Pages** → `bayclubconnect-bookings` → Settings → Variables and
  Secrets → view (not reveal) configured secrets
