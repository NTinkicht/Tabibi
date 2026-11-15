# Guest notifications through the PWA (Web Push) — design specification

Status: owner-approved direction, 2026-11-15. The owner chose a PWA with Web Push over WhatsApp,
SMS or a store app because it costs nothing, needs no account, and keeps guests' phone numbers and
status links off third-party messaging platforms. This document applies `PRODUCT.md` TAB-P2-03
("extra notification provider integrations, subject to owner budget and privacy approval") at zero
spend. It keeps every contract in `ARCHITECTURE.md` and `SECURITY.md`. Gap register: G-22, G-23.

## What the guest gets

| Moment | What the guest sees | Delivered as |
|---|---|---|
| Right after allowing notifications | "Notifications activées. Touchez pour ouvrir votre suivi." | a guest-link intent (`initial`) carrying a fresh single-use exchange link |
| Turn approaching, called, estimate changed materially, session delayed, session cancelled, entry cancelled | the existing template copy (`turn_approaching.v1`, `patient_called.v1`, …), fr or ar | the notification outbox, `push` channel |
| Transfer to another session or doctor | "Votre passage a été déplacé. Touchez pour voir votre nouveau suivi." | a guest-link intent (`transfer`) carrying a fresh exchange link for the target |
| Status cookie expired or missing on tap | the status page offers "M’envoyer un nouveau lien" | a guest-link intent (`resend`) to the same subscription |

Guests who don't allow notifications, use an unsupported browser, or have no smartphone keep
today's options: the in-app notification centre on the status page, and the receptionist's
printed link and QR code (#734). Push adds a channel and replaces nothing.

**Lock-screen privacy.** A notification's visible text names no clinic, doctor, specialty,
patient or position number. The title is always "Tabibi". The body is the template's generic
sentence ("Votre tour approche", "On vous appelle"). Anyone who picks up the phone learns only
that the owner uses Tabibi.

## Parts

### 1. PWA shell (TAB-PWA-1)

- `/manifest.webmanifest`:
  - `name`/`short_name` "Tabibi", `start_url: "/guest/status"`, `scope: "/"`, `display: "standalone"`;
  - theme and background colours from `foundations.md`;
  - 192, 512 and maskable icons, plus `lang`/`dir` for the requested locale (fr default; `?locale=ar` serves the Arabic variant).
- `/sw.js`, a service worker served from the site root with `Cache-Control: no-cache` and `Service-Worker-Allowed: /`. It handles **only** `push`, `notificationclick` and `pushsubscriptionchange`:
  - **No `fetch` handler and no Cache Storage.** It caches nothing, so status, queue or patient data never lands on the device beyond what the browser already keeps.
  - `push`: parse `{ v: 1, kind: 'status' | 'link', title, body, url, tag }`, then `showNotification(title, { body, tag, lang, dir, icon })`. `tag` collapses repeats of the same kind.
  - `notificationclick`: focus an open Tabibi window or open `url`. `url` must be same-origin and start with `/guest/status` or `/api/guest/exchange/`; anything else opens `/guest/status`.
  - `pushsubscriptionchange`: POST the new subscription to the re-subscribe route (part 3), proving possession of the old one.
- Registered only on guest pages (`/guest/status`, booking confirmation, live queue). Staff pages never register it.
- The existing CSP (`default-src 'self'`) already allows a same-origin worker and manifest. No CSP change.

### 2. Notification dispatch scheduler (TAB-PWA-2, G-23)

Nothing dispatches notifications automatically today. `POST /api/clinics/{clinicId}/notifications/dispatch` runs one batch only when staff call it, and no page calls it. Guest-link intents created by transfers have no dispatcher at all. They expire unsent and are scrubbed.

- Add a worker entry point `scripts/worker/notification-dispatch.ts` (`npm run worker:notifications`) and a `worker` service in `docker-compose.yml`. Every `NOTIFICATION_DISPATCH_INTERVAL_MS` (default 15000) it:
  1. runs the outbox batch runner for each clinic with due intents (limit 50 per clinic per tick);
  2. runs `GuestLinkIntentStore.dispatchNext` until nothing is due or 50 sends have run;
  3. runs `scrubExpired()`.
- It must be safe with two workers running: claims, leases and fences already make this so, and a test proves it.
- The sender for each channel comes from a registry: in-app (existing) and push (part 4). A channel with no configured sender leaves its intents pending until they expire. They are scrubbed as today and never "delivered".
- It logs counts only (claimed, delivered, retried, dead-lettered, suppressed, scrubbed): never ids of patients, entries, subscriptions or exchanges.
- The staff dispatch route stays as it is.

### 3. Push subscription binding (TAB-PWA-3, owner-attended: Claude)

Migration `guest_push_subscriptions`:
- `id`, `clinic_id`, `queue_entry_id` (FK, same clinic), `endpoint_hash` (HMAC-SHA256 of the endpoint, unique while active);
- `sealed_subscription` (AES-GCM envelope of `{endpoint, keys.p256dh, keys.auth}`, AAD = `clinic_id|queue_entry_id|id`, key from runtime configuration and never from the DB or Git, the same rule as the guest-link envelope);
- `locale`, `created_at`, `expires_at`, `revoked_at`, `revocation_reason`.
- CHECK: a revoked or expired row has `sealed_subscription IS NULL`.

The migration also:
- extends `guest_exchange_ids.contact_kind` with `'push'`;
- makes `issued_by_user_id` nullable only when `contact_kind = 'push'`, so the system can issue a link to a verified subscription. Every other issuance still needs a staff actor.

Routes (all `no-store`, `Referrer-Policy: no-referrer`, same-origin, bounded body, rate-limited):

- **`POST /api/guest/push-subscription`**:
  - **Authentication:** the exchange-origin status cookie, or the booking-origin bearer in `Authorization`. It never accepts both, and neither credential is converted into the other.
  - **Body:** the browser's `PushSubscription` JSON plus `locale`.
  - **Endpoint allow-list:** the endpoint's host must be a known push service (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`). Any other host is refused with 400, which blocks SSRF through a crafted endpoint. The endpoint must use HTTPS with no credentials, port or fragment.
  - **In one transaction:**
    - upsert the binding for the credential's entry (the same endpoint re-binds rather than duplicates; at most 3 active subscriptions per entry);
    - record a `push` notification preference with `consentState: 'granted'` for the entry's `visit_patient` subject;
    - issue a system exchange (`contact_kind = 'push'`) and create an `initial` guest-link intent;
    - append audit `guest_push_subscribed` with metadata `{ subscriptionId, locale }` only.
  - **Response:** `{ subscribed: true }`, with nothing secret.
- **`DELETE /api/guest/push-subscription`**:
  - the same credentials, or proof of possession (below);
  - revokes the binding, scrubs `sealed_subscription`, sets the `push` preference consent to `revoked`, and audits `guest_push_unsubscribed`.
- **`POST /api/guest/push-subscription/resend`**:
  - **Body:** `{ endpoint }` from `pushManager.getSubscription()`.
  - **Lookup:** by `endpoint_hash`, for an active binding whose entry is still active.
  - **On success:** issues a system exchange and a `resend` intent.
  - **Always answers 202** with the same body, whether or not a binding matched, so it can't be used to test endpoints.
  - **Limits:** 3 per binding per hour and a global ingress bucket.
  - **Why the endpoint alone is enough:** the link goes only to that subscription, and only the device holding its private keys can decrypt it. Knowing an endpoint without those keys gives nothing.
- **`POST /api/guest/push-subscription/renew`**: used by `pushsubscriptionchange`. The body carries the old and new endpoints. The binding is replaced only when the old endpoint matches an active binding. No link is issued.

Lifecycle:

- **Expiry:** a binding lives until the entry reaches a terminal state, plus the existing 15-minute terminal grace, and at most 24 hours. Then it is revoked as `expired` and scrubbed.
- **Transfer:** inside `QueueTransferService`'s transaction, active bindings move to the target entry. The AAD is re-sealed and the `push` preference is copied. The existing `transfer` intent then reaches the guest by push. The source binding no longer exists, so the old entry can't notify.
- **Gone:** a push service answering 404 or 410 means the subscription is gone. The binding is revoked as `gone` and scrubbed.

### 4. Web Push sender (TAB-PWA-4, owner-attended: Claude)

- Dependency: `web-push` (MPL-2.0, used unmodified as a package, which that licence allows without affecting Tabibi's own code), for VAPID JWT signing and RFC 8291 `aes128gcm` payload encryption. There is no paid service and no account.
- Configuration: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (an `https:` or `mailto:` URI the owner chooses), set in the hosting environment. If they are missing, the push sender is not registered, so its intents stay pending and expire. Startup never fails because of them, and the public key is served to the page from `GET /api/guest/push-subscription/key`.
- `PushNotificationProviderAdapter` (`channel = 'push'`) for outbox intents:
  - resolves the active binding for the intent's queue entry at dispatch time, after the existing consent check, and unseals it;
  - sends `{ v:1, kind:'status', title:'Tabibi', body, url:'/guest/status', tag:templateId }` with `TTL` 600 (1800 for delays and cancellations) and `Urgency: high` for `patient_called` and `turn_approaching`.
- `GuestLinkIntentStore.dispatchNext` changes in three ways for this sender:
  - The `LinkSender` context gains `clinicId`, `queueEntryId` and `exchangeExpiresAt`. Today it carries only `intentId` and `idempotencyKey`, so a sender cannot find the guest's subscription.
  - A sender may answer `no_channel` (the entry has no active push binding) or `gone` (404/410). Both finish the claim as `dead_letter` and scrub it at once, instead of retrying until expiry.
  - A thrown error stays retryable, as today.
- `PushGuestLinkSender` (a `LinkSender`) for guest-link intents:
  - sends `{ v:1, kind:'link', title:'Tabibi', body, url:'/api/guest/exchange/<id>', tag:'link' }`;
  - sets `TTL` to the exchange's remaining lifetime, rounded down, and never sends when less than 60 seconds remain.
  - The exchange ID exists in plaintext only in memory between unseal and the encrypted push. It is never logged, put in an error, or stored.
- Result mapping:

| Push service answer | Outcome |
|---|---|
| 201 or 202 | `delivered` |
| 404 or 410 | `terminal_failure` `push_subscription_gone`, and the binding is revoked |
| 400, 403 or 413 | `terminal_failure` `push_rejected` |
| 429 or 5xx | retryable `failed` `push_unavailable`, honouring `Retry-After` within the existing back-off |
| network or timeout | `unknown` |

- Outbound requests have a 5-second timeout, follow no redirects, and only reach allow-listed hosts.
- Retries reuse the intent's idempotency key. The `Topic` header (at most 32 URL-safe base64 characters) is the first 32 characters of base64url(SHA-256(idempotency key)), so a push service collapses duplicates without seeing the key itself.

### 5. Status page and help (TAB-PWA-5)

On `/guest/status` and the booking confirmation page, below the status panel, add a "Notifications" card with these states:

| State | Copy (fr) | Action |
|---|---|---|
| not supported | "Votre navigateur ne permet pas les notifications. Gardez cette page ouverte ou demandez le lien imprimé à l’accueil." | none |
| iPhone, not installed | "Sur iPhone : touchez Partager, puis « Sur l’écran d’accueil », et ouvrez Tabibi depuis l’icône." | none |
| available | "Recevez une alerte quand votre tour approche." | primary "Activer les notifications" (the permission prompt only on this tap) |
| denied | "Notifications bloquées dans le navigateur. Vous pouvez les autoriser dans les réglages du site." | none |
| active | "Notifications activées sur cet appareil." | secondary "Désactiver" |

- The Arabic copy follows the same structure. Use `role="status"` for state changes.
- When opened without a valid status credential, the status page also offers "M’envoyer un nouveau lien", if `pushManager.getSubscription()` returns one. It calls the resend route and then shows "Si cet appareil est inscrit, un lien arrive dans quelques secondes."
- `/guest/notification-help` explains what Tabibi sends, that nothing names the clinic on the lock screen, and how to switch notifications off.

### 6. iPhone home-screen linking (TAB-PWA-6, spike, owner-attended: Claude)

iOS delivers Web Push only to a site added to the Home Screen and opened from that icon. The
installed app does not share cookies with Safari, so it starts with no status access. The spike tests one approach on a real iPhone: a per-visit manifest whose `start_url` is a fresh system exchange link, issued only to a page that already holds a valid status credential. If it works, the installed app opens straight into the guest's status. If it does not, iPhone guests keep the in-app centre and the printed link, and the "iPhone, not installed" copy changes to say so. No other approach (pairing codes, clipboard) is used without a new spec.

## Security rules

- **Credential classes stay separate.** A push subscription is not a credential. It can only receive a link that the guest still has to open. A link from a push opens through the existing `/api/guest/exchange/{id}` route, so single use, the 10-minute TTL, verifier-only storage and the status-only cookie all apply unchanged. Push never mints a WU63/WU64/WU65 booking bearer.
- **What goes into a push payload** is the visible text, the `url` and the tag. It never carries a patient name, clinic, doctor, specialty or position, and it never carries a status cookie or booking bearer.
- **How subscription details are stored.** Endpoints and keys are sealed at rest. Lookups use only a keyed hash. None of them appears in a log, audit row, metric or error.
- **Where requests can go.** Requests go only to the endpoint allow-list, with no redirects, as a fixed SSRF boundary.
- **When the subscription changes.** Binding changes (subscribe, transfer, revoke, expiry) happen in the same transaction as the entry change they follow.
- **Running without push.** With no VAPID keys configured, the product behaves exactly as today.

## Owner actions (no cost)

1. When staging exists (#731), generate a VAPID key pair once with `npx web-push generate-vapid-keys`. Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` as hosting secrets, and set `VAPID_SUBJECT` to a contact URI. Never commit them.
2. Test on a real Android phone and, for TAB-PWA-6, a real iPhone. Push needs HTTPS, so this happens on staging, not localhost.

## Acceptance

- Unit and integration tests, PostgreSQL included, cover:
  - subscription authentication with each credential class, with cross-class and mixed credentials refused;
  - the endpoint allow-list, including SSRF cases (IP literals, ports, userinfo, unknown hosts);
  - sealing and AAD tamper rejection, plus the scrub CHECKs;
  - the cap of 3 subscriptions per entry and rebinding the same endpoint;
  - consent granted on subscribe and revoked on unsubscribe;
  - resend answering identically for unknown and known endpoints, with its rate limits;
  - transfer moving bindings atomically;
  - expiry and terminal revocation;
  - 410 revoking the binding.
- The sender is tested against a local fake push service: it checks VAPID headers and decrypts the `aes128gcm` payload to assert its exact shape. The tests also assert:
  - that a delivered `link` payload's exchange opens once;
  - that no exchange ID, endpoint or key appears in logs, audit rows or errors;
  - that the TTL header never outlives the exchange.
- Scheduler tests: two workers never deliver one intent twice, a channel without a sender leaves intents pending, and logs carry counts only.
- Playwright, fr and ar at 320 px:
  - service worker registration on guest pages only;
  - the notification card in each state, using a mocked `Notification.permission` and `PushManager`;
  - `notificationclick` opening only allowed URLs;
  - no Cache Storage entries after a status visit.
