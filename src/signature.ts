import crypto from "node:crypto";
export function verifySignature(
  raw: string,
  signature: string,
  secret: string,
) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(raw)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature.replace(/^sha256=/, "")),
  );
}
