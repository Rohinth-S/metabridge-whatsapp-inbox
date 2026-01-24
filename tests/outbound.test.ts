import { describe, expect, it, beforeEach } from "vitest";
import { db } from "../src/db.js";
import { createMessageRepository } from "../src/repository.js";

describe("outbound delivery queue", () => {
  beforeEach(() => { db.exec("DELETE FROM outbound_messages"); });
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
});
