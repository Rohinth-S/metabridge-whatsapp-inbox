import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import { db } from "../src/db.js";
import { createMessageRepository } from "../src/repository.js";

const payload = {
  object: "whatsapp_business_account",
  entry: [{ changes: [{ value: { messages: [{ id: "wamid-1", from: "919999999999", to: "918888888888", type: "text", text: { body: "Need help with my order" } }] } }] }],
};

beforeEach(() => {
  for (const table of ["idempotency", "reviews", "conversations", "messages"]) db.prepare(`DELETE FROM ${table}`).run();
});

describe("MetaBridge webhook inbox", () => {
  it("deduplicates provider retries", async () => {
    const a = await request(app).post("/webhook").set("x-idempotency-key", "retry-1").send(payload);
    const b = await request(app).post("/webhook").set("x-idempotency-key", "retry-1").send(payload);
    expect(a.body.accepted).toBe(1);
    expect(b.body.accepted).toBe(1);
    expect(db.prepare("SELECT count(*) c FROM messages").get()).toEqual({ c: 1 });
  });

  it("protects operator inbox endpoints", async () => {
    expect((await request(app).get("/inbox")).status).toBe(401);
    expect((await request(app).get("/inbox").set("x-admin-key", "local-admin-key")).status).toBe(200);
  });

  it("routes and reviews a persisted message", async () => {
    const accepted = await request(app).post("/webhook").set("x-idempotency-key", "route-1").send(payload);
    const message = db.prepare("SELECT id FROM messages WHERE provider_id=?").get("wamid-1") as { id: string };
    const routed = await request(app).post(`/inbox/${message.id}/route`).set("x-admin-key", "local-admin-key").send({ team: "fulfillment", priority: "high" });
    const reviewed = await request(app).post(`/inbox/${message.id}/review`).set("x-admin-key", "local-admin-key").send({ reviewer: "ops@example.test", decision: "approve", note: "Verified" });
    expect(accepted.body.accepted).toBe(1);
    expect(routed.body.status).toBe("routed");
    expect(reviewed.body.status).toBe("approved");
    expect(db.prepare("SELECT assigned_team FROM conversations WHERE phone=?").get("919999999999")).toEqual({ assigned_team: "fulfillment" });
    expect(db.prepare("SELECT decision FROM reviews WHERE message_id=?").get(message.id)).toEqual({ decision: "approve" });
  });

  it("rejects unsupported mixed persistence mode", () => {
    const originalUrl = process.env.DB_URL;
    const originalFlag = process.env.POSTGRES_ROUTES_ENABLED;
    process.env.DB_URL = "postgres://example.invalid/metabridge";
    delete process.env.POSTGRES_ROUTES_ENABLED;
    expect(() => createMessageRepository()).toThrow(/refusing to mix async Postgres routes/);
    if (originalUrl === undefined) delete process.env.DB_URL; else process.env.DB_URL = originalUrl;
    if (originalFlag === undefined) delete process.env.POSTGRES_ROUTES_ENABLED; else process.env.POSTGRES_ROUTES_ENABLED = originalFlag;
  });
});
