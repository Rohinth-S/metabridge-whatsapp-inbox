import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: any };
import fs from "node:fs";
import path from "node:path";
const file = process.env.DB_FILE ?? "./data/metabridge.db";
fs.mkdirSync(path.dirname(file), { recursive: true });
export const db: any = new DatabaseSync(file);
db.exec(
  `CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,provider_id TEXT UNIQUE NOT NULL,from_number TEXT NOT NULL,to_number TEXT NOT NULL,body TEXT NOT NULL,kind TEXT NOT NULL,received_at TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('new','routed','needs_review','approved','rejected')),raw_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,phone TEXT UNIQUE NOT NULL,assigned_team TEXT,priority TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id),reviewer TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),note TEXT,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS idempotency(key TEXT PRIMARY KEY,response_json TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outbound_messages(id TEXT PRIMARY KEY,to_number TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','sending','sent','retry','dead')),attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL,last_error TEXT,provider_message_id TEXT,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS outbound_ready_idx ON outbound_messages(status,next_attempt_at); CREATE TABLE IF NOT EXISTS outbound_delivery_events(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES outbound_messages(id),status TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS outbound_delivery_events_created_idx ON outbound_delivery_events(created_at);`,
);
