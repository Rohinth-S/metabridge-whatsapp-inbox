-- Managed Supabase Postgres schema for MetaBridge.
-- The API uses a server-side connection; RLS is enabled as defense in depth.
CREATE TABLE IF NOT EXISTS metabridge_messages (id uuid PRIMARY KEY, provider_id text UNIQUE NOT NULL, from_number text NOT NULL, to_number text NOT NULL, body text NOT NULL, kind text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL CHECK (status IN ('new','routed','needs_review','approved','rejected')), raw_json jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS metabridge_conversations (id uuid PRIMARY KEY, phone text UNIQUE NOT NULL, assigned_team text, priority text NOT NULL CHECK (priority IN ('low','normal','high')), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS metabridge_reviews (id uuid PRIMARY KEY, message_id uuid NOT NULL REFERENCES metabridge_messages(id), reviewer text NOT NULL, decision text NOT NULL CHECK (decision IN ('approve','reject')), note text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS metabridge_idempotency (key text PRIMARY KEY, response_json jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS metabridge_messages_status_received_idx ON metabridge_messages(status, received_at DESC);
CREATE TABLE IF NOT EXISTS metabridge_outbound_messages (id uuid PRIMARY KEY, to_number text NOT NULL, body text NOT NULL, status text NOT NULL CHECK (status IN ('queued','sending','sent','retry','dead')), attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL, last_error text, provider_message_id text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS metabridge_outbound_ready_idx ON metabridge_outbound_messages(status, next_attempt_at);
ALTER TABLE metabridge_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE metabridge_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE metabridge_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE metabridge_idempotency ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_full_access ON metabridge_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_full_access ON metabridge_conversations FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_full_access ON metabridge_reviews FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_role_full_access ON metabridge_idempotency FOR ALL TO service_role USING (true) WITH CHECK (true);
ALTER TABLE metabridge_outbound_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_full_access ON metabridge_outbound_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
