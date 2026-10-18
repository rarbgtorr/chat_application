# Wingfactor Support Chat

A private, responsive support workspace for clients, teammates, and the administrator. Clients get a private chat link; teammates see a client ID and only their assigned conversations. Both sides can send text, images, videos, audio, voice recordings, PDFs, Word documents, TXT, and CSV files.

## Implemented behaviour

- **Server-enforced privacy:** client name, contact, and admin notes live in a separate table. These fields are omitted from teammate and client API responses. No teammate can list users, change assignments, generate client links, or delete rooms.
- **Private client access:** 256-bit access secret in the URL fragment, exchanged for an HttpOnly cookie. Secrets are hashed in storage and removed from the address bar. Anyone holding the original link has access; share it privately. Replacement/revocation invalidates existing client links, sessions, and push subscriptions.
- **Persistent staff sign-in:** no server inactivity timeout. Browser cookie persists for a rolling year (subject to browser limits). Sessions remain valid across server restarts. Manual logout, password changes, admin revocation, or browser-data removal require sign-in again. Never promise that a browser will retain a cookie forever.
- **Live chat:** server-sent events trigger immediate reconciliation; standard authenticated requests save messages. Reconnection, tab visibility, and a 30-second safety refresh recover missed events. Retries use message nonces to avoid duplicate messages.
- **Background Web Push:** a service worker can notify registered devices without an open chat tab. Multiple phone/laptop subscriptions per user are supported. Subscriptions are tied to a server session; logging out or revoking a session removes its subscriptions and pending push jobs. Notification payloads use client IDs and generic text, without contact data or attachment names.
- **Escalation:** the first unanswered client message starts a durable cycle. Additional client messages do not reset it. At **5 minutes**, notify assigned active teammates. At **10 minutes**, notify active administrators. Reading does not stop the timer. Any staff reply, including a file-only reply, ends the cycle and cancels pending reminders/escalations. A new client message after a reply starts a new cycle. Worker checks every second; actual push delivery may take longer.
- **Durable history:** messages, media, sessions, push jobs, and escalation deadlines persist in `DATA_DIR`. There is no automatic message or attachment expiry. Closed rooms are read-only and retain history. Only an administrator can permanently delete a room.
- **Direct media:** no admin approval step. Maximum file size: **25 MB per attachment**. Voice recordings stop after three minutes and are sent only when the user presses Send. PDFs/documents download; supported image/audio/video files have inline previews. Media uses authenticated endpoints, not public upload URLs.
- **Room controls:** assign multiple teammates, reassign without losing history, edit admin-only contact notes, close/reopen, replace/revoke access, permanently delete. Add, disable, re-enable, and reset teammate accounts. Only the command-line admin tool creates additional administrators.

Identity details inside messages, recordings, file contents, and filenames are visible to the recipient by design. There is no content redaction or end-to-end encryption: the trusted server stores and processes the conversation.

## Local setup

Requires **Node.js 24.15+ (24.x)** and npm. `node:sqlite` is built into this Node version. The runtime dependency is `web-push`.

```bash
npm ci --ignore-scripts
cp .env.example .env
npm run create-admin
npm start
```

The admin command prompts for a username, display name, and hidden password (minimum 14 characters). There are no default credentials or public staff signup. Open `http://localhost:3000`. Set `PUSH_CONTACT=mailto:your-real-address@your-domain.com` to enable Web Push. HTTPS is required for notifications outside localhost.

For automation, the admin script also accepts `{ "username", "name", "password" }` as JSON on standard input. Supply secrets through your host’s secret manager or a protected stdin stream, never in repository files or command-line arguments.

### First use

1. Sign in as administrator.
2. Open **Your team → Add teammate**. Share credentials privately.
3. Create a conversation; fill optional admin-only details and assign teammates.
4. Copy the generated client link and send it through WhatsApp. The link is shown only when created; a replacement revokes the previous link.
5. Teammates sign in at the main URL. Clients open their private link. Use separate browser profiles/devices when testing both roles; a browser profile has one active account.
6. Each participant opens **Settings → Enable notifications → Send test alert** on every device they use.

On mobile, add the app to the Home Screen where supported. On iPhone/iPad, Web Push requires a supported installed Home Screen web app. The app can be used from the browser without installing, but platform push support varies.

## Production deployment

This application needs **one always-on Node process with a persistent disk**, HTTPS, and outbound HTTPS to browser push services. A static deployment, a sleeping free service, an ephemeral container filesystem, or a request-only serverless function is not sufficient. The timer worker runs inside the Node process. Run **one application instance**; do not horizontally scale this SQLite/in-process SSE design.

The repository includes a Dockerfile and Docker Compose deployment with Caddy TLS and a persistent volume. On your server:

1. Point a domain/subdomain at the server and allow inbound ports 80 and 443.
2. Clone this repository and create a protected `.env` file:

```dotenv
DOMAIN=support.your-domain.com
PUSH_CONTACT=mailto:you@your-domain.com
```

3. Run `docker compose up -d --build`.
4. Create the administrator interactively:

```bash
docker compose exec app node scripts/create-admin.js
```

5. Visit the HTTPS domain and complete the first-use steps above. Alternatively, set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the host’s environment for the first boot only, then remove them. They are used only when the user database is empty.

`compose.yaml` mounts a named `chat_data` volume at `/app/data`; it includes SQLite, uploads, and stable VAPID keys. **Do not delete this volume or regenerate `vapid.json` during upgrades.** Changing the public VAPID key requires devices to resubscribe.

For a managed host instead of Compose, use the Dockerfile, attach persistent storage at `/app/data`, set `APP_URL` to the exact HTTPS origin and `PUSH_CONTACT`, and keep the service running continuously. Set proxy buffering off for `/api/events`; Caddy is already configured to flush promptly. Do not put client access tokens in a URL query string or proxy log.

### Railway settings

Deploy the repository's Dockerfile as one Railway service. Attach a volume at `/app/data` **before** first use and keep one replica. Railway volumes are mounted as root; with this Dockerfile, use `RAILWAY_RUN_UID=0` as Railway's documented volume-permission workaround, or arrange ownership for the `node` UID before starting. Set `APP_URL` to the generated HTTPS service domain, `PUSH_CONTACT` to a real `mailto:` contact or an HTTPS contact URL, and healthcheck path to `/healthz`. Disable **Serverless/App Sleeping**: the reminder worker must keep running when nobody is using the app. Do not deploy the Caddy Compose service on Railway; its public proxy handles TLS.

Choose restart settings supported by your account/plan. Hosting and persistent disk can incur charges; confirm the provider's plan and usage limits before activating production hosting. Railway installation alone does not create a deployed application.

### Notifications and fast response

- Notification permission, internet, browser support, device power settings, and Do Not Disturb affect delivery. Keeping the user signed in does not guarantee immediate OS notifications. Push acceptance is not proof that the phone displayed an alert.
- Test on the actual teammate/admin devices with the screen locked and the chat backgrounded. Verify both the 5-minute teammate reminder and the 10-minute admin escalation. These device tests have to happen after HTTPS deployment.
- Browser push and live chat are separate. The server worker can send push when there is no live SSE connection; it does not require a chat tab to be open.
- Pending jobs survive restarts. Failed sends retry with backoff for up to 24 hours. Gone/invalid endpoints (404/410) are removed. Notifications may be delivered more than once if the server stops after a push service accepts a request but before recording success.
- An outage delays reminders; the first worker pass after recovery catches up against the original timestamps. Closed/deleted rooms and revoked access stop their pending escalations. A notification already handed to a push service cannot be recalled.
- The allowlist in `validPushEndpoint()` supports standard Chrome/FCM, Firefox/Mozilla, and Apple endpoints. Unsupported browser push providers require an explicit reviewed allowlist addition.

### Persistence, backup, and deletion

There is no retention timer. Storage grows until the administrator deletes rooms. Monitor disk space. An uploaded file that was never sent is still retained within its room until room deletion.

Back up the **complete data directory**, including uploads and VAPID keys. Use SQLite’s backup API or stop the application while copying the directory; copying only the live `.sqlite` file without its WAL is unsafe. Restore the directory and its ownership before starting a replacement instance. Backups are separate copies: apply your own backup retention/deletion policy when deleting a client’s data.

Teammates/clients cannot delete saved history. Account revocation does not erase history. Deleting a room removes its records and files from active application storage. File deletion failures remain in a durable retry queue for the background worker. No contacts, credentials, session secrets, message bodies, or private access links are written to application logs.

## Checks

```bash
npm run check
npm test
npm audit --omit=dev --audit-level=high
```

Tests use real local HTTP requests and temporary SQLite databases. They cover privacy and authorization, bidirectional/idempotent messaging, direct media access/ranges, history pagination, exact escalation thresholds, reply cancellation, reassignment, access revocation, long-lived sessions, room deletion, CSRF rejection, push endpoint restrictions, restart persistence, and SSE events. Push delivery is mocked in the tests; real phone delivery and visual/browser QA remain deployment acceptance checks.

GitHub Actions runs syntax checks, tests, and the production dependency audit on pushes and pull requests.

## Primary technical references

- [Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
- [MDN server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [Web Push for Node.js](https://github.com/web-push-libs/web-push)
- [WebKit: Web Push for web apps on iOS/iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
