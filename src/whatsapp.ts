export type WhatsAppSendResult = { providerMessageId: string };

export async function sendWhatsAppText(to: string, body: string, fetchImpl: typeof fetch = fetch): Promise<WhatsAppSendResult> {
  const token = process.env.META_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) throw new Error("META_ACCESS_TOKEN and META_PHONE_NUMBER_ID are required for outbound delivery");
  const response = await fetchImpl(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
  });
  const payload = await response.json() as { messages?: Array<{ id?: string }>; error?: { message?: string } };
  if (!response.ok || !payload.messages?.[0]?.id) throw new Error(payload.error?.message ?? `WhatsApp delivery failed (${response.status})`);
  return { providerMessageId: payload.messages[0].id };
}
