# Wingfactor Support Chat

Private client support chat, designed for **Netlify Free + Supabase Free**. GitHub preserves the source; Netlify serves the website and proxies its API; Supabase runs the API, database, realtime updates, private file storage, push delivery, and scheduled jobs.

## Behaviour

- Clients open a private link. Teammates sign in and see assigned client IDs. Only administrators can see stored client names, contacts, and private notes.
- Text, images, videos, audio, voice notes, PDFs, Word, TXT, and CSV files reach recipients directly. Maximum attachment size: **25 MB**.
- Attachments expire **7 days after upload**. Access stops at expiry; the scheduled worker deletes the object, normally on the next minute pass. Deletion failures stay queued for retry. Chat history shows **Attachment expired**. Text messages remain until the administrator deletes the conversation.
- Staff sessions have no server inactivity timeout; a persistent HttpOnly, Secure, SameSite cookie renews on requests. Explicit logout, password changes, access revocation, and clearing browser storage can end access. Push is independent of an open chat connection.
- The first unanswered client message starts a cycle. Additional client messages do not restart it. At **5 minutes**, remind assigned teammates. At **10 minutes**, notify administrators. Any staff reply, including a file-only reply, ends the cycle and cancels pending escalation jobs. Reading a message does not count as replying.
- Room assignment, reassignment, close/reopen, client-link replacement/revocation, permanent room deletion, staff disable/reset, and multi-device notification registration are included.
- Voice notes are recorded for up to three minutes, then shared only when Send is pressed.

Identity inside messages, filenames, recordings, or document contents remains visible by design. The server processes messages; this is not end-to-end encryption.

## Current deployment resources

- Netlify project: `wingfactor-support-chat` (site ID `370880c6-bc6f-4a7c-afe4-5f6899e3e2c2`).
- Expected website origin: `https://wingfactor-support-chat.netlify.app`.
- Supabase project: existing `interview-support-slot-booking` (`nmgjkexfgytjivxudsmo`) on the confirmed Free organisation. Chat uses separate `wc_` tables, the `wingchat` function, `wingchat-worker` job, and private `wingchat-media` bucket. The booking app's tables and functions are separate. Resources/quotas are shared.
- `netlify.toml` builds `dist/`, proxies `/api/*` to the chat function, and provides the client room fallback plus security headers. No secret environment variable is needed in the frontend.

The production website is deployed at `https://wingfactor-support-chat.netlify.app`. Source is saved in this GitHub repository; the current release was published with the CLI. Link the repository in Netlify if automatic deployment on pushes is wanted. Set production visitor access to Public; application accounts and private client links protect chat data. The account's default Netlify team-login gate must not block clients or service-worker notifications. Preview deployments should use a separate backend/configuration, because writes accept only the configured production origin.

## Security model

Every chat table has RLS enabled, explicit deny policies, and revoked privileges for `anon` and `authenticated`. All chat RPCs are executable only by `service_role`. The Edge Function owns the privileged key through Supabase's built-in server environment and checks the hashed custom session and room assignment on every operation. Private contact records are fetched only in administrator requests.

Staff passwords use salted **PBKDF2-HMAC-SHA256, 600,000 iterations** through Web Crypto. Session and client-link secrets have 256 bits of randomness and are stored as SHA-256 hashes. Setup uses a one-time hashed secret and expiry, with a transaction preventing reuse. Client links use URL fragments, which are exchanged for cookies and removed from the address bar. Share links privately: anyone holding a valid link has client access.

Realtime uses random per-session notification topics. Broadcasts carry **only an empty wake-up event**, never messages, contacts, or attachments. A wake-up causes the browser to fetch authorized data from the API. Possessing a realtime topic does not grant API access. Session revocation removes the topic from future recipients. Browser publishable keys cannot read chat tables, storage objects, or chat RPCs directly.

Private media is served through short signed URLs after authorization, with lifetime bounded by its seven-day expiry. Do not share signed URLs: they remain usable until their short expiry. Already downloaded client files cannot be recalled.

## Background jobs

`wingchat-worker` invokes `/functions/v1/wingchat/worker` every minute via `pg_cron` + `pg_net`, authenticated with a random server-only worker secret. Worker/configuration secrets and stable VAPID keys live in the access-restricted `wc_settings` table; none are committed here. The Edge Function handles its own authentication, so platform JWT verification is disabled for this function only.

The worker processes durable reminder cycles, claims push jobs using leases, retries transient push failures with backoff, removes invalid push endpoints, and expires/removes media. Message sends also launch a background worker pass for prompt new-message alerts. Push subscriptions are tied to server sessions; logout/revocation cascades pending jobs. Database message insertion and response-cycle updates are atomic and serialize per room.

Cron checks run once per minute: a reminder is eligible at the five/ten-minute threshold and processed on the next check. Device/network delivery can add delay. A notification already accepted by a push service cannot be recalled. Push-service acceptance is not proof that a phone displayed an alert.

## Free-plan limits

The organisation/project must stay on Free and no paid add-ons should be enabled. Current published allowances include 500 MB database, 1 GB file storage, and 2 million realtime messages/month; Netlify Free is subject to its account allowance. Verify current limits in provider dashboards. Other apps on the same account/project share applicable quotas.

Upload reservations are serialized and reject new files if total project storage plus reservations would exceed **900 MiB**, leaving headroom under the storage quota. This is a file-upload safeguard, not a guarantee for every metered resource. Monitor database size, realtime usage, requests, bandwidth, and storage. Keeping attachments seven days does not cap how much can be uploaded during that week.

Free projects may pause or reach usage limits; free plans do not provide guaranteed uninterrupted service. No paid project was created for this chat app. Backups and any copies downloaded by recipients have their own retention rules.

## Deploy and configure

1. Apply the SQL in `supabase/migrations/` to a chosen Supabase project. Do not apply the migrations twice. The current project's migrations are already applied.
2. Configure the access-restricted `wc_settings` entries: `config` contains origin, public/publishable key, VAPID keys, contact URI, and worker secret. `setup` contains the hash of a random one-time setup key and its millisecond expiry. Never commit these values or expose server keys in client bundles.
3. Deploy `supabase/functions/wingchat/index.ts` with its `core.js` dependency, with `verify_jwt = false` because it enforces its own cookies/worker authentication. `SUPABASE_SECRET_KEYS.default` or the built-in `SUPABASE_SERVICE_ROLE_KEY` is server-only.
4. Schedule the minute worker using a server-side secret; existing project job is already configured.
5. Link the Netlify project to this GitHub repo, production branch `main`. Build: `npm run build`; publish: `dist`. Netlify connection state is ignored in Git via `.netlify/`.
6. Once published, open the private one-time `/#setup=...` link to create your admin account, then add teammates and create client rooms. The setup secret is not stored in the repository. It can be reissued by the server owner if it expires before first use.
7. On each phone/laptop, open Settings → Enable notifications → Send test alert. Test with the screen locked and app backgrounded. iOS/iPadOS needs a supported Home Screen installation for Web Push.

Changing the website origin requires updating the server-only config and any proxy/CSP settings. Keep the VAPID keys stable so devices do not need to resubscribe. Never disable secret scanning to ship a real secret.

## Build and checks

Requires Node.js 24.15+ (24.x).

```bash
npm ci --ignore-scripts
npm run build
npm run check
npm test
npm audit --omit=dev --audit-level=high
```

`test/interface.test.js` checks the UI, escaping, client link handling, admin controls, and preservation of media/drafts during updates. `scripts/verify-hosted.js` is a manual live acceptance test that takes temporary test credentials through hidden stdin; it covers the deployed API, sessions, privacy, access control, WebSocket events, message retries, direct media, and replies. Live test users/rooms must be removed after verification.

The original SQLite server and its integration tests remain as a self-hosted reference/regression fixture. **The Netlify deployment uses the Supabase backend, not `server/`.** The legacy server does not implement the hosted seven-day retention policy and should not be used for this production configuration. Docker/Compose files describe that earlier self-hosted option only.

Actual locked-screen phone notification delivery and visual browser QA require verification on the deployed website/devices; DOM/API tests do not establish those results.
