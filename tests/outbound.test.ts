import { describe, expect, it, beforeEach } from "vitest";
import { db } from "../src/db.js";
import { createMessageRepository } from "../src/repository.js";

describe("outbound delivery queue", () => {
  beforeEach(() => { db.exec("DELETE FROM outbound_delivery_events; DELETE FROM outbound_messages"); });
  it("claims queued work once and moves it to retry or sent", async () => {
    const repo = createMessageRepository();
    const queued = await repo.enqueueOutbound({ id: "out-1", toNumber: "+919999999999", body: "Hello", now: new Date(0).toISOString() });
    expect(queued.status).toBe("queued");
    const claimed = await repo.claimOutbound(new Date(1).toISOString());
    expect(claimed?.status).toBe("sending");
    expect(await repo.claimOutbound(new Date(1).toISOString())).toBeUndefined();
    await repo.markOutboundFailure("out-1", "provider unavailable", new Date(0).toISOString(), false);
    expect((await repo.listOutbound("retry"))[0].attempts).toBe(1);
  });

  it("records dead-letter state and exposes operator metrics", async () => {
    const repo = createMessageRepository();
    await repo.enqueueOutbound({ id: "out-dead", toNumber: "+919999999998", body: "Retry me", now: new Date(0).toISOString() });
    expect(await repo.claimOutbound(new Date(1).toISOString())).toBeTruthy();
    await repo.markOutboundFailure("out-dead", "permanent provider rejection", new Date(0).toISOString(), true);
    expect((await repo.listOutbound("dead"))[0].lastError).toContain("permanent");
    const metrics = await repo.metrics();
    expect(metrics.outbound.dead).toBe(1);
  });

  it("builds delivery analytics from the durable attempt history", async () => {
    const repo = createMessageRepository();
    await repo.enqueueOutbound({ id: "out-analytics", toNumber: "+919999999997", body: "Track me", now: new Date().toISOString() });
    const claimed = await repo.claimOutbound(new Date().toISOString());
    expect(claimed?.id).toBe("out-analytics");
    await repo.markOutboundSent("out-analytics", "wamid.analytics", new Date().toISOString());
    const analytics = await repo.deliveryAnalytics(24);
    expect(analytics.attempts).toBe(1);
    expect(analytics.sent).toBe(1);
    expect(analytics.successRate).toBeGreaterThan(0);
  });
});
