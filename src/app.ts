import express, { Request } from "express";
import cors from "cors";
import crypto from "node:crypto";
import { z } from "zod";
import { createMessageRepository } from "./repository.js";
import { verifySignature } from "./signature.js";

export const repository = createMessageRepository();
const adminKey = process.env.ADMIN_API_KEY ?? (process.env.NODE_ENV === "production" ? "" : "local-admin-key");
function adminAuth(req: Request, res: express.Response, next: express.NextFunction) {
  if (!adminKey) return res.status(503).json({ error: "ADMIN_API_KEY is not configured" });
  if (req.header("x-admin-key") !== adminKey) return res.status(401).json({ error: "invalid admin key" });
  next();
}

const app = express();
const corsOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
app.use(cors({ origin: (origin, callback) => {
  if (!origin || (process.env.NODE_ENV !== "production" && corsOrigins.length === 0) || corsOrigins.includes(origin)) callback(null, true);
  else callback(new Error("origin not allowed"));
} }));
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
app.get("/health", (_req, res) => res.json({ service: "metabridge", status: "ok", persistence: repository.mode }));
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] !== (process.env.META_VERIFY_TOKEN ?? "metabridge-dev")) return res.sendStatus(403);
  res.type("text/plain").send(req.query["hub.challenge"] ?? "");
});

const incoming = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.object({ changes: z.array(z.object({ value: z.object({ messages: z.array(z.object({ id: z.string(), from: z.string(), to: z.string(), type: z.string().default("text"), text: z.object({ body: z.string() }).optional() })) }) })) })),
});

app.post("/webhook", async (req, res) => {
  const raw = (req as any).rawBody ?? JSON.stringify(req.body);
  const sig = req.header("x-hub-signature-256") ?? "";
  if (process.env.NODE_ENV === "production" && !verifySignature(raw, sig, process.env.META_APP_SECRET ?? "")) return res.status(401).json({ error: "invalid signature" });
  const parsed = incoming.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "unsupported payload" });
  const key = req.header("x-idempotency-key") ?? crypto.createHash("sha256").update(raw).digest("hex");
  const messages = parsed.data.entry.flatMap((entry) => entry.changes.flatMap((change) => change.value.messages.map((message) => ({ providerId: message.id, fromNumber: message.from, toNumber: message.to, body: message.text?.body ?? `[${message.type}]`, kind: message.type, rawJson: JSON.stringify(message) }))));
  const response = await repository.acceptWebhook(key, messages, new Date().toISOString());
  res.status(200).json(response);
});

app.get("/inbox", adminAuth, async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "new";
  const allowed = ["new", "routed", "needs_review", "approved", "rejected"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "invalid status" });
  res.json(await repository.listMessages(status));
});

app.post("/inbox/:id/route", adminAuth, async (req, res) => {
  const parsed = z.object({ team: z.string().min(2), priority: z.enum(["low", "normal", "high"]).default("normal") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const updated = await repository.routeMessage(String(req.params.id), parsed.data.team, parsed.data.priority, new Date().toISOString());
  if (!updated) return res.status(404).json({ error: "message not found" });
  res.json({ id: String(req.params.id), status: "routed", team: parsed.data.team });
});

app.post("/inbox/:id/review", adminAuth, async (req, res) => {
  const parsed = z.object({ reviewer: z.string().min(2), decision: z.enum(["approve", "reject"]), note: z.string().max(1000).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const updated = await repository.reviewMessage(String(req.params.id), parsed.data.reviewer, parsed.data.decision, parsed.data.note ?? null, new Date().toISOString());
  if (!updated) return res.status(404).json({ error: "message not found" });
  res.json({ id: String(req.params.id), status: parsed.data.decision === "approve" ? "approved" : "rejected" });
});

export default app;
