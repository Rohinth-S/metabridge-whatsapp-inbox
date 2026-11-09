import crypto from "node:crypto";
import { Pool } from "pg";
import { db } from "./db.js";

export type IncomingMessage = {
  providerId: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  kind: string;
  rawJson: string;
};

export type RepositoryMode = "sqlite" | "postgres";
export type OutboundStatus = "queued" | "sending" | "sent" | "retry" | "dead";
export type OutboundMessage = {
  id: string;
  toNumber: string;
  body: string;
  status: OutboundStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  providerMessageId: string | null;
  createdAt: string;
};
export type DeliveryAnalytics = {
  windowHours: number;
  attempts: number;
  queued: number;
  sending: number;
  sent: number;
  retry: number;
  dead: number;
  successRate: number;
  averageAttempts: number;
};

export interface MessageRepository {
  readonly mode: RepositoryMode;
  initialize(): Promise<void>;
  acceptWebhook(key: string, messages: IncomingMessage[], now: string): Promise<{ accepted: number }>;
  listMessages(status: string): Promise<any[]>;
  routeMessage(id: string, team: string, priority: string, now: string): Promise<boolean>;
  reviewMessage(id: string, reviewer: string, decision: "approve" | "reject", note: string | null, now: string): Promise<boolean>;
  enqueueOutbound(input: { id: string; toNumber: string; body: string; now: string }): Promise<OutboundMessage>;
  claimOutbound(now: string): Promise<OutboundMessage | undefined>;
  markOutboundSent(id: string, providerMessageId: string, now: string): Promise<void>;
  markOutboundFailure(id: string, error: string, nextAttemptAt: string, dead: boolean): Promise<void>;
  listOutbound(status?: OutboundStatus): Promise<OutboundMessage[]>;
  metrics(): Promise<{ inbound: Record<string, number>; outbound: Record<string, number> }>;
  deliveryAnalytics(windowHours?: number): Promise<DeliveryAnalytics>;
  close(): Promise<void>;
}

export function postgresConnectionString(): string | undefined {
  return process.env.DB_URL || process.env.SUPABASE_DB_URL || undefined;
}

function assertModeConfiguration() {
  if (postgresConnectionString() && process.env.POSTGRES_ROUTES_ENABLED !== "true") {
    throw new Error("DB_URL/SUPABASE_DB_URL is configured but POSTGRES_ROUTES_ENABLED is not true; refusing to mix async Postgres routes with SQLite");
  }
}

class SqliteMessageRepository implements MessageRepository {
  readonly mode = "sqlite" as const;

  async initialize() {}

  private transaction<T>(work: () => T): T {
    db.exec("BEGIN");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private recordDeliveryEvent(messageId: string, status: OutboundStatus, now: string, error: string | null = null) {
    db.prepare("INSERT INTO outbound_delivery_events (id,message_id,status,error,created_at) VALUES (?,?,?,?,?)")
      .run(crypto.randomUUID(), messageId, status, error?.slice(0, 1000) ?? null, now);
  }

  async acceptWebhook(key: string, messages: IncomingMessage[], now: string): Promise<{ accepted: number }> {
    return this.transaction(() => {
      const existing = db.prepare("SELECT response_json FROM idempotency WHERE key=?").get(key) as any;
      if (existing) return JSON.parse(existing.response_json);
      let accepted = 0;
      for (const message of messages) {
        try {
          db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), message.providerId, message.fromNumber, message.toNumber, message.body, message.kind, now, "new", message.rawJson);
          db.prepare("INSERT INTO conversations VALUES (?,?,?,?,?) ON CONFLICT(phone) DO UPDATE SET updated_at=excluded.updated_at").run(crypto.randomUUID(), message.fromNumber, "triage", "normal", now);
          accepted += 1;
        } catch {
          // Provider retries are normal; the unique provider_id constraint makes this idempotent.
        }
      }
      const response = { accepted };
      db.prepare("INSERT INTO idempotency VALUES (?,?,?)").run(key, JSON.stringify(response), now);
      return response;
    }) as { accepted: number };
  }

  async listMessages(status: string): Promise<any[]> {
    return db.prepare("SELECT * FROM messages WHERE status=? ORDER BY received_at DESC LIMIT 100").all(status) as any[];
  }

  async routeMessage(id: string, team: string, priority: string, now: string): Promise<boolean> {
    return this.transaction(() => {
      const message = db.prepare("SELECT id,from_number FROM messages WHERE id=?").get(id) as any;
      if (!message) return false;
      db.prepare("UPDATE messages SET status='routed' WHERE id=?").run(id);
      db.prepare("UPDATE conversations SET assigned_team=?,priority=?,updated_at=? WHERE phone=?").run(team, priority, now, message.from_number);
      return true;
    });
  }

  async reviewMessage(id: string, reviewer: string, decision: "approve" | "reject", note: string | null, now: string): Promise<boolean> {
    return this.transaction(() => {
      const message = db.prepare("SELECT id FROM messages WHERE id=?").get(id) as any;
      if (!message) return false;
      const status = decision === "approve" ? "approved" : "rejected";
      db.prepare("UPDATE messages SET status=? WHERE id=?").run(status, id);
      db.prepare("INSERT INTO reviews VALUES (?,?,?,?,?,?)").run(crypto.randomUUID(), id, reviewer, decision, note, now);
      return true;
    });
  }

  async enqueueOutbound(input: { id: string; toNumber: string; body: string; now: string }) {
    db.prepare("INSERT INTO outbound_messages VALUES (?,?,?,?,?,?,?,?,?)").run(input.id, input.toNumber, input.body, "queued", 0, input.now, null, null, input.now);
    this.recordDeliveryEvent(input.id, "queued", input.now);
    return { id: input.id, toNumber: input.toNumber, body: input.body, status: "queued" as const, attempts: 0, nextAttemptAt: input.now, lastError: null, providerMessageId: null, createdAt: input.now };
  }
  async claimOutbound(now: string) {
    return this.transaction(() => {
      const row = db.prepare("SELECT * FROM outbound_messages WHERE status IN ('queued','retry') AND next_attempt_at<=? ORDER BY created_at LIMIT 1").get(now) as any;
      if (!row) return undefined;
      db.prepare("UPDATE outbound_messages SET status='sending',attempts=attempts+1 WHERE id=?").run(row.id);
      this.recordDeliveryEvent(row.id, "sending", now);
      return { id: row.id, toNumber: row.to_number, body: row.body, status: "sending" as const, attempts: row.attempts + 1, nextAttemptAt: row.next_attempt_at, lastError: row.last_error, providerMessageId: row.provider_message_id, createdAt: row.created_at };
    });
  }
  async markOutboundSent(id: string, providerMessageId: string, now: string) { db.prepare("UPDATE outbound_messages SET status='sent',provider_message_id=?,last_error=NULL,next_attempt_at=? WHERE id=?").run(providerMessageId, now, id); this.recordDeliveryEvent(id, "sent", now); }
  async markOutboundFailure(id: string, error: string, nextAttemptAt: string, dead: boolean) { const status = dead ? "dead" : "retry"; db.prepare("UPDATE outbound_messages SET status=?,last_error=?,next_attempt_at=? WHERE id=?").run(status, error.slice(0, 1000), nextAttemptAt, id); this.recordDeliveryEvent(id, status, new Date().toISOString(), error); }
  async listOutbound(status?: OutboundStatus) { const rows = status ? db.prepare("SELECT * FROM outbound_messages WHERE status=? ORDER BY created_at DESC").all(status) : db.prepare("SELECT * FROM outbound_messages ORDER BY created_at DESC").all(); return (rows as any[]).map((row) => ({ id: row.id, toNumber: row.to_number, body: row.body, status: row.status, attempts: row.attempts, nextAttemptAt: row.next_attempt_at, lastError: row.last_error, providerMessageId: row.provider_message_id, createdAt: row.created_at })); }
  async metrics() { const inboundRows = db.prepare("SELECT status,COUNT(*) count FROM messages GROUP BY status").all() as any[]; const outboundRows = db.prepare("SELECT status,COUNT(*) count FROM outbound_messages GROUP BY status").all() as any[]; return { inbound: Object.fromEntries(inboundRows.map((r) => [r.status, Number(r.count)])), outbound: Object.fromEntries(outboundRows.map((r) => [r.status, Number(r.count)])) }; }
  async deliveryAnalytics(windowHours = 24) {
    const boundedHours = Math.min(24 * 30, Math.max(1, Math.floor(windowHours)));
    const cutoff = new Date(Date.now() - boundedHours * 60 * 60_000).toISOString();
    const rows = db.prepare("SELECT status,COUNT(*) AS count FROM outbound_delivery_events WHERE created_at>=? GROUP BY status").all(cutoff) as any[];
    const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)])) as Record<string, number>;
    const attempts = counts.sending ?? 0;
    const sent = counts.sent ?? 0;
    const dead = counts.dead ?? 0;
    const messageAttempts = db.prepare("SELECT AVG(attempts) AS average FROM outbound_messages WHERE created_at>=?").get(cutoff) as { average: number | null };
    const terminal = sent + dead;
    return { windowHours: boundedHours, attempts, queued: counts.queued ?? 0, sending: counts.sending ?? 0, sent, retry: counts.retry ?? 0, dead, successRate: terminal ? Number((sent / terminal).toFixed(4)) : 0, averageAttempts: Number((messageAttempts.average ?? 0).toFixed(2)) };
  }

  async close() {}
}

const schema = `
CREATE TABLE IF NOT EXISTS metabridge_messages (
  id TEXT PRIMARY KEY, provider_id TEXT UNIQUE NOT NULL, from_number TEXT NOT NULL, to_number TEXT NOT NULL,
  body TEXT NOT NULL, kind TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('new','routed','needs_review','approved','rejected')), raw_json JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS metabridge_conversations (
  id TEXT PRIMARY KEY, phone TEXT UNIQUE NOT NULL, assigned_team TEXT, priority TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS metabridge_reviews (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES metabridge_messages(id), reviewer TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject')), note TEXT, created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS metabridge_idempotency (key TEXT PRIMARY KEY, response_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS metabridge_messages_status_received_idx ON metabridge_messages(status, received_at DESC);
CREATE TABLE IF NOT EXISTS metabridge_outbound_messages (id TEXT PRIMARY KEY,to_number TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','sending','sent','retry','dead')),attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TIMESTAMPTZ NOT NULL,last_error TEXT,provider_message_id TEXT,created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS metabridge_outbound_ready_idx ON metabridge_outbound_messages(status,next_attempt_at);
`;

class PostgresMessageRepository implements MessageRepository {
  readonly mode = "postgres" as const;
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: process.env.PGSSLMODE === "disable" ? undefined : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX ?? 10),
    });
  }

  async initialize() {
    // The managed schema is applied by sql/postgres-schema.sql during provisioning.
    // Keeping startup read/write-only prevents an application deploy from changing DDL.
  }

  async acceptWebhook(key: string, metabridge_messages: IncomingMessage[], now: string): Promise<{ accepted: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT response_json FROM metabridge_idempotency WHERE key=$1", [key]);
      if (existing.rowCount) {
        await client.query("COMMIT");
        return existing.rows[0].response_json as { accepted: number };
      }
      let accepted = 0;
      for (const message of metabridge_messages) {
        const inserted = await client.query(
          "INSERT INTO metabridge_messages (id,provider_id,from_number,to_number,body,kind,received_at,status,raw_json) VALUES ($1,$2,$3,$4,$5,$6,$7,'new',$8::jsonb) ON CONFLICT(provider_id) DO NOTHING RETURNING id",
          [crypto.randomUUID(), message.providerId, message.fromNumber, message.toNumber, message.body, message.kind, now, message.rawJson],
        );
        if (!inserted.rowCount) continue;
        await client.query(
          "INSERT INTO metabridge_conversations (id,phone,assigned_team,priority,updated_at) VALUES ($1,$2,'triage','normal',$3) ON CONFLICT(phone) DO UPDATE SET updated_at=EXCLUDED.updated_at",
          [crypto.randomUUID(), message.fromNumber, now],
        );
        accepted += 1;
      }
      const response = { accepted };
      await client.query("INSERT INTO metabridge_idempotency (key,response_json,created_at) VALUES ($1,$2::jsonb,$3)", [key, JSON.stringify(response), now]);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listMessages(status: string): Promise<any[]> {
    const result = await this.pool.query("SELECT * FROM metabridge_messages WHERE status=$1 ORDER BY received_at DESC LIMIT 100", [status]);
    return result.rows;
  }

  async routeMessage(id: string, team: string, priority: string, now: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const message = await client.query("SELECT id,from_number FROM metabridge_messages WHERE id=$1 FOR UPDATE", [id]);
      if (!message.rowCount) { await client.query("ROLLBACK"); return false; }
      await client.query("UPDATE metabridge_messages SET status='routed' WHERE id=$1", [id]);
      await client.query("UPDATE metabridge_conversations SET assigned_team=$1,priority=$2,updated_at=$3 WHERE phone=$4", [team, priority, now, message.rows[0].from_number]);
      await client.query("COMMIT");
      return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async reviewMessage(id: string, reviewer: string, decision: "approve" | "reject", note: string | null, now: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const message = await client.query("SELECT id FROM metabridge_messages WHERE id=$1 FOR UPDATE", [id]);
      if (!message.rowCount) { await client.query("ROLLBACK"); return false; }
      const status = decision === "approve" ? "approved" : "rejected";
      await client.query("UPDATE metabridge_messages SET status=$1 WHERE id=$2", [status, id]);
      await client.query("INSERT INTO metabridge_reviews (id,message_id,reviewer,decision,note,created_at) VALUES ($1,$2,$3,$4,$5,$6)", [crypto.randomUUID(), id, reviewer, decision, note, now]);
      await client.query("COMMIT");
      return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  private async recordDeliveryEvent(messageId: string, status: OutboundStatus, now: string, error: string | null = null) {
    await this.pool.query(
      "INSERT INTO metabridge_outbound_delivery_events (id,message_id,status,error,created_at) VALUES ($1,$2,$3,$4,$5)",
      [crypto.randomUUID(), messageId, status, error?.slice(0, 1000) ?? null, now],
    );
  }
  async enqueueOutbound(input: { id: string; toNumber: string; body: string; now: string }) { const result = await this.pool.query("INSERT INTO metabridge_outbound_messages (id,to_number,body,status,attempts,next_attempt_at,created_at) VALUES ($1,$2,$3,'queued',0,$4,$4) RETURNING *", [input.id, input.toNumber, input.body, input.now]); await this.recordDeliveryEvent(input.id, "queued", input.now); return this.toOutbound(result.rows[0]); }
  async claimOutbound(now: string) { const client = await this.pool.connect(); try { await client.query("BEGIN"); const result = await client.query("SELECT * FROM metabridge_outbound_messages WHERE status IN ('queued','retry') AND next_attempt_at<=$1 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1", [now]); if (!result.rowCount) { await client.query("COMMIT"); return undefined; } const updated = await client.query("UPDATE metabridge_outbound_messages SET status='sending',attempts=attempts+1 WHERE id=$1 RETURNING *", [result.rows[0].id]); await client.query("INSERT INTO metabridge_outbound_delivery_events (id,message_id,status,created_at) VALUES ($1,$2,'sending',$3)", [crypto.randomUUID(), result.rows[0].id, now]); await client.query("COMMIT"); return this.toOutbound(updated.rows[0]); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } }
  async markOutboundSent(id: string, providerMessageId: string, now: string) { await this.pool.query("UPDATE metabridge_outbound_messages SET status='sent',provider_message_id=$1,last_error=NULL,next_attempt_at=$2 WHERE id=$3", [providerMessageId, now, id]); await this.recordDeliveryEvent(id, "sent", now); }
  async markOutboundFailure(id: string, error: string, nextAttemptAt: string, dead: boolean) { const status = dead ? "dead" : "retry"; const eventAt = new Date().toISOString(); await this.pool.query("UPDATE metabridge_outbound_messages SET status=$1,last_error=$2,next_attempt_at=$3 WHERE id=$4", [status, error.slice(0, 1000), nextAttemptAt, id]); await this.recordDeliveryEvent(id, status, eventAt, error); }
  async listOutbound(status?: OutboundStatus) { const result = status ? await this.pool.query("SELECT * FROM metabridge_outbound_messages WHERE status=$1 ORDER BY created_at DESC", [status]) : await this.pool.query("SELECT * FROM metabridge_outbound_messages ORDER BY created_at DESC"); return result.rows.map((row) => this.toOutbound(row)); }
  async metrics() { const inbound = await this.pool.query("SELECT status,COUNT(*)::int count FROM metabridge_messages GROUP BY status"); const outbound = await this.pool.query("SELECT status,COUNT(*)::int count FROM metabridge_outbound_messages GROUP BY status"); return { inbound: Object.fromEntries(inbound.rows.map((r) => [r.status, r.count])), outbound: Object.fromEntries(outbound.rows.map((r) => [r.status, r.count])) }; }
  async deliveryAnalytics(windowHours = 24) { const boundedHours = Math.min(24 * 30, Math.max(1, Math.floor(windowHours))); const result = await this.pool.query("SELECT status,COUNT(*)::int count FROM metabridge_outbound_delivery_events WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour') GROUP BY status", [boundedHours]); const counts = Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)])) as Record<string, number>; const attempts = counts.sending ?? 0; const sent = counts.sent ?? 0; const dead = counts.dead ?? 0; const averages = await this.pool.query("SELECT AVG(attempts)::float8 AS average FROM metabridge_outbound_messages WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')", [boundedHours]); const averageAttempts = Number(averages.rows[0]?.average ?? 0); const terminal = sent + dead; return { windowHours: boundedHours, attempts, queued: counts.queued ?? 0, sending: counts.sending ?? 0, sent, retry: counts.retry ?? 0, dead, successRate: terminal ? Number((sent / terminal).toFixed(4)) : 0, averageAttempts: Number(averageAttempts.toFixed(2)) }; }
  private toOutbound(row: any): OutboundMessage { return { id: row.id, toNumber: row.to_number, body: row.body, status: row.status, attempts: Number(row.attempts), nextAttemptAt: row.next_attempt_at, lastError: row.last_error, providerMessageId: row.provider_message_id, createdAt: row.created_at }; }

  async close() { await this.pool.end(); }
}

export function createMessageRepository(): MessageRepository {
  assertModeConfiguration();
  const connectionString = postgresConnectionString();
  return connectionString ? new PostgresMessageRepository(connectionString) : new SqliteMessageRepository();
}
