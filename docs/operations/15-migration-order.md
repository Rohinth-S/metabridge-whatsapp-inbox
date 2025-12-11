# MetaBridge operations: migration order

## Purpose

This runbook records the production contract for MetaBridge's WhatsApp webhook, inbox routing, review, and persistence paths. It keeps provider retries and operator actions auditable without exposing message content or credentials.

## Checks

- Verify the raw request signature before trusting the parsed WhatsApp envelope.
- Treat the provider message ID and idempotency key as the deduplication boundary.
- Route and review through the repository interface and use the prefixed Supabase tables from sql/postgres-schema.sql.
- Confirm POSTGRES_ROUTES_ENABLED=true before enabling managed persistence.

## Failure handling

A malformed or unauthenticated webhook must be rejected without creating inbox rows. A database or provider timeout should preserve the retryable request and produce a correlation identifier for operators; never acknowledge a partially persisted batch.

## Verification

Run 
pm test, 
pm run lint, and 
pm run build. Production checks should cover a signed webhook, duplicate delivery, operator authentication, routing, review, and graceful shutdown.
