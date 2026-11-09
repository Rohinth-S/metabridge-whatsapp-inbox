import { describe, expect, it } from "vitest";
import { sendWhatsAppText } from "../src/whatsapp.js";

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
});
