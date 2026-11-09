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

export interface MessageRepository {
  readonly mode: RepositoryMode;
  initialize(): Promise<void>;
  acceptWebhook(key: string, messages: IncomingMessage[], now: string): Promise<{ accepted: number }>;
  listMessages(status: string): Promise<any[]>;
  routeMessage(id: string, team: string, priority: string, now: string): Promise<boolean>;
  reviewMessage(id: string, reviewer: string, decision: "approve" | "reject", note: string | null, now: string): Promise<boolean>;
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

  async close() { await this.pool.end(); }
}

export function createMessageRepository(): MessageRepository {
  assertModeConfiguration();
  const connectionString = postgresConnectionString();
  return connectionString ? new PostgresMessageRepository(connectionString) : new SqliteMessageRepository();
}
