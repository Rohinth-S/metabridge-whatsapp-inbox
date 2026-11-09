export type WhatsAppSendResult = {
  providerMessageId: string;
  provider: "primary" | "fallback";
  attempts: number;
};

type ProviderConfig = {
  name: "primary" | "fallback";
  token: string;
  phoneNumberId: string;
  baseUrl: string;
};

function configFromEnv(name: ProviderConfig["name"]): ProviderConfig | undefined {
  const prefix = name === "primary" ? "META" : "META_FALLBACK";
  const token = process.env[`${prefix}_ACCESS_TOKEN`];
  const phoneNumberId = process.env[`${prefix}_PHONE_NUMBER_ID`];
  if (!token && !phoneNumberId) return undefined;
  if (!token || !phoneNumberId) throw new Error(`${prefix}_ACCESS_TOKEN and ${prefix}_PHONE_NUMBER_ID must be configured together`);
  return {
    name,
    token,
    phoneNumberId,
    baseUrl: process.env[`${prefix}_GRAPH_BASE_URL`] ?? "https://graph.facebook.com/v20.0",
  };
}

async function sendWithProvider(to: string, body: string, provider: ProviderConfig, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(`${provider.baseUrl.replace(/\/$/, "")}/${provider.phoneNumberId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.token}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
  });
  const payload = await response.json() as { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } };
  if (!response.ok || !payload.messages?.[0]?.id) {
    const suffix = payload.error?.code ? ` [${payload.error.code}]` : "";
    throw new Error(`${payload.error?.message ?? `WhatsApp delivery failed (${response.status})`}${suffix}`);
  }
  return payload.messages[0].id;
}

export async function sendWhatsAppText(to: string, body: string, fetchImpl: typeof fetch = fetch): Promise<WhatsAppSendResult> {
  const primary = configFromEnv("primary");
  if (!primary) throw new Error("META_ACCESS_TOKEN and META_PHONE_NUMBER_ID are required for outbound delivery");
  return { providerMessageId: await sendWithProvider(to, body, primary, fetchImpl), provider: "primary", attempts: 1 };
}

/** Try the primary WhatsApp account and then a separately configured fallback account. */
export async function sendWhatsAppTextWithFallback(to: string, body: string, fetchImpl: typeof fetch = fetch): Promise<WhatsAppSendResult> {
  const providers = [configFromEnv("primary"), configFromEnv("fallback")].filter(Boolean) as ProviderConfig[];
  if (!providers.length) throw new Error("META_ACCESS_TOKEN and META_PHONE_NUMBER_ID are required for outbound delivery");
  const errors: string[] = [];
  for (let index = 0; index < providers.length; index += 1) {
    try {
      return { providerMessageId: await sendWithProvider(to, body, providers[index], fetchImpl), provider: providers[index].name, attempts: index + 1 };
    } catch (error) {
      errors.push(`${providers[index].name}: ${error instanceof Error ? error.message : "delivery failed"}`);
    }
  }
  throw new Error(errors.join("; "));
}
