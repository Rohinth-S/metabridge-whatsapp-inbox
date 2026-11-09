import { describe, expect, it } from "vitest";
import { sendWhatsAppText, sendWhatsAppTextWithFallback } from "../src/whatsapp.js";

describe("WhatsApp Cloud API adapter", () => {
  it("sends a text payload and returns the provider id", async () => {
    const previousToken = process.env.META_ACCESS_TOKEN;
    const previousPhone = process.env.META_PHONE_NUMBER_ID;
    process.env.META_ACCESS_TOKEN = "test-token";
    process.env.META_PHONE_NUMBER_ID = "phone-123";
    let request: RequestInit | undefined;
    try {
      const result = await sendWhatsAppText("+919999999999", "Hello", async (_url, init) => {
        request = init;
        return new Response(JSON.stringify({ messages: [{ id: "wamid.test" }] }), { status: 200 });
      });
      expect(result.providerMessageId).toBe("wamid.test");
      expect(request?.method).toBe("POST");
      expect(JSON.parse(String(request?.body))).toMatchObject({
        messaging_product: "whatsapp",
        to: "+919999999999",
        text: { body: "Hello" },
      });
    } finally {
      if (previousToken === undefined) delete process.env.META_ACCESS_TOKEN;
      else process.env.META_ACCESS_TOKEN = previousToken;
      if (previousPhone === undefined) delete process.env.META_PHONE_NUMBER_ID;
      else process.env.META_PHONE_NUMBER_ID = previousPhone;
    }
  });

  it("surfaces provider errors for queue retry handling", async () => {
    process.env.META_ACCESS_TOKEN = "test-token";
    process.env.META_PHONE_NUMBER_ID = "phone-123";
    try {
      await expect(
        sendWhatsAppText("+919999999999", "Hello", async () =>
          new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }),
        ),
      ).rejects.toThrow("rate limited");
    } finally {
      delete process.env.META_ACCESS_TOKEN;
      delete process.env.META_PHONE_NUMBER_ID;
    }
  });

  it("fails over to a secondary account when the primary provider is unavailable", async () => {
    process.env.META_ACCESS_TOKEN = "primary-token";
    process.env.META_PHONE_NUMBER_ID = "primary-phone";
    process.env.META_FALLBACK_ACCESS_TOKEN = "fallback-token";
    process.env.META_FALLBACK_PHONE_NUMBER_ID = "fallback-phone";
    process.env.META_FALLBACK_GRAPH_BASE_URL = "https://fallback.test/v20.0";
    const calls: string[] = [];
    try {
      const result = await sendWhatsAppTextWithFallback("+919999999999", "Hello", async (url) => {
        calls.push(url);
        if (url.includes("fallback.test")) return new Response(JSON.stringify({ messages: [{ id: "wamid.fallback" }] }), { status: 200 });
        return new Response(JSON.stringify({ error: { message: "primary unavailable" } }), { status: 503 });
      });
      expect(result).toMatchObject({ providerMessageId: "wamid.fallback", provider: "fallback", attempts: 2 });
      expect(calls).toHaveLength(2);
    } finally {
      delete process.env.META_ACCESS_TOKEN;
      delete process.env.META_PHONE_NUMBER_ID;
      delete process.env.META_FALLBACK_ACCESS_TOKEN;
      delete process.env.META_FALLBACK_PHONE_NUMBER_ID;
      delete process.env.META_FALLBACK_GRAPH_BASE_URL;
    }
  });
});
