import express, { Request, Response } from "express";
import cors from "cors";
import crypto from "node:crypto";
import { z } from "zod";
import { db } from "./db.js";
import { verifySignature } from "./signature.js";
const adminKey =
  process.env.ADMIN_API_KEY ??
  (process.env.NODE_ENV === "production" ? "" : "local-admin-key");
function adminAuth(req: Request, res: Response, next: Function) {
  if (!adminKey)
    return res.status(503).json({ error: "ADMIN_API_KEY is not configured" });
  if (req.header("x-admin-key") !== adminKey)
    return res.status(401).json({ error: "invalid admin key" });
  next();
}
const app = express();
const corsOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        (process.env.NODE_ENV !== "production" && corsOrigins.length === 0) ||
        corsOrigins.includes(origin)
      )
        callback(null, true);
      else callback(new Error("origin not allowed"));
    },
  }),
);
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);
app.get("/health", (_, res) =>
  res.json({ service: "metabridge", status: "ok" }),
);
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.verify_token"] !==
    (process.env.META_VERIFY_TOKEN ?? "metabridge-dev")
  )
    return res.sendStatus(403);
  res.type("text/plain").send(req.query["hub.challenge"] ?? "");
});
const incoming = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            messages: z.array(
              z.object({
                id: z.string(),
                from: z.string(),
                to: z.string(),
                type: z.string().default("text"),
                text: z.object({ body: z.string() }).optional(),
              }),
            ),
          }),
        }),
      ),
    }),
  ),
});
app.post("/webhook", (req, res) => {
  const raw = (req as any).rawBody ?? JSON.stringify(req.body);
  const sig = req.header("x-hub-signature-256") ?? "";
  if (
    process.env.NODE_ENV === "production" &&
    !verifySignature(raw, sig, process.env.META_APP_SECRET ?? "")
  )
    return res.status(401).json({ error: "invalid signature" });
  const parsed = incoming.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "unsupported payload" });
  const key =
    req.header("x-idempotency-key") ??
    crypto.createHash("sha256").update(raw).digest("hex");
  const existing = db
    .prepare("SELECT response_json FROM idempotency WHERE key=?")
    .get(key) as any;
  if (existing) return res.status(200).json(JSON.parse(existing.response_json));
  let accepted = 0;
  for (const e of parsed.data.entry)
    for (const c of e.changes)
      for (const m of c.value.messages) {
        const body = m.text?.body ?? `[${m.type}]`;
        try {
          db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)").run(
            crypto.randomUUID(),
            m.id,
            m.from,
            m.to,
            body,
            m.type,
            new Date().toISOString(),
            "new",
            JSON.stringify(m),
          );
          db.prepare(
            "INSERT INTO conversations VALUES (?,?,?,?,?) ON CONFLICT(phone) DO UPDATE SET updated_at=excluded.updated_at",
          ).run(
            crypto.randomUUID(),
            m.from,
            "triage",
            "normal",
            new Date().toISOString(),
          );
          accepted++;
        } catch {
          continue;
        }
      }
  const response = { accepted };
  db.prepare("INSERT INTO idempotency VALUES (?,?,?)").run(
    key,
    JSON.stringify(response),
    new Date().toISOString(),
  );
  res.status(200).json(response);
});
app.get("/inbox", adminAuth, (req, res) => {
  const status =
    typeof req.query.status === "string" ? req.query.status : "new";
  const allowed = ["new", "routed", "needs_review", "approved", "rejected"];
  if (!allowed.includes(status))
    return res.status(400).json({ error: "invalid status" });
  res.json(
    db
      .prepare(
        "SELECT * FROM messages WHERE status=? ORDER BY received_at DESC LIMIT 100",
      )
      .all(status),
  );
});
app.post("/inbox/:id/route", adminAuth, (req, res) => {
  const p = z
    .object({
      team: z.string().min(2),
      priority: z.enum(["low", "normal", "high"]).default("normal"),
    })
    .safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  const m = db
    .prepare("SELECT * FROM messages WHERE id=?")
    .get(req.params.id) as any;
  if (!m) return res.status(404).json({ error: "message not found" });
  db.prepare("UPDATE messages SET status='routed' WHERE id=?").run(m.id);
  db.prepare(
    "UPDATE conversations SET assigned_team=?,priority=?,updated_at=? WHERE phone=?",
  ).run(p.data.team, p.data.priority, new Date().toISOString(), m.from_number);
  res.json({ id: m.id, status: "routed", team: p.data.team });
});
app.post("/inbox/:id/review", adminAuth, (req, res) => {
  const p = z
    .object({
      reviewer: z.string().min(2),
      decision: z.enum(["approve", "reject"]),
      note: z.string().max(1000).optional(),
    })
    .safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.flatten() });
  const m = db
    .prepare("SELECT * FROM messages WHERE id=?")
    .get(req.params.id) as any;
  if (!m) return res.status(404).json({ error: "message not found" });
  const state = p.data.decision === "approve" ? "approved" : "rejected";
  db.prepare("UPDATE messages SET status=? WHERE id=?").run(state, m.id);
  db.prepare("INSERT INTO reviews VALUES (?,?,?,?,?,?)").run(
    crypto.randomUUID(),
    m.id,
    p.data.reviewer,
    p.data.decision,
    p.data.note ?? null,
    new Date().toISOString(),
  );
  res.json({ id: m.id, status: state });
});
export default app;
