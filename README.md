# MetaBridge

MetaBridge is a WhatsApp Cloud API inbox boundary. It turns webhook deliveries into an idempotent, reviewable workflow: verify the request, persist the message, route the conversation, and record an explicit approval decision. The implementation is provider-shaped but provider-independent at the storage and review boundaries, making it safe to run locally without a Meta account.

## Architecture

```mermaid
sequenceDiagram
  participant Meta as Meta WhatsApp Cloud API
  participant API as MetaBridge API
  participant Store as SQLite
  participant Admin as Review console
  Meta->>API: POST /webhook + HMAC signature
  API->>API: validate payload + idempotency key
  API->>Store: persist message/conversation
  API-->>Meta: 200 accepted
  Admin->>API: route or review message
  API->>Store: append decision
```

## Workflow

1. Meta sends a signed webhook event.
2. The API verifies the HMAC in production and validates the supported message envelope.
3. The provider message ID and idempotency key prevent duplicate inbox rows during retries.
4. Operators route messages to a team and priority queue.
5. Reviewers approve or reject with an auditable note.

## Structure

- `src/app.ts`: webhook, inbox, routing, and review routes.
- `src/signature.ts`: constant-time HMAC verification.
- `src/db.ts`: message, conversation, review, and idempotency tables.
- `tests/`: retry/deduplication contract test.

## Run locally

Requires Node.js 22.5 or newer because the local adapter uses the built-in `node:sqlite` module.

```bash
npm install
cp .env.example .env
npm run dev
npm test
```

## Production hardening

Use a queue between webhook acknowledgement and downstream processing, encrypt phone numbers at rest, verify Meta's app-secret proof, rotate `ADMIN_API_KEY`, add tenant filters, rate-limit operator actions, and publish outbound responses through a retryable outbox. The local SQLite adapter keeps the behavior deterministic for demos and tests.

## Security

Configure `META_APP_SECRET`, `META_VERIFY_TOKEN`, `ADMIN_API_KEY`, and `CORS_ORIGINS` in production. Webhook delivery is HMAC-checked in production; operator inbox endpoints require `X-Admin-Key` and are never anonymous.
