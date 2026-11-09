import { createClient } from "@supabase/supabase-js";

export type SignedUpload = {
  uploadUrl: string;
  token?: string;
  objectKey: string;
  expiresIn: number;
  provider: "supabase" | "local";
};

function configured() {
  return Boolean(
    process.env.SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      (process.env.SUPABASE_STORAGE_BUCKET ?? process.env.STORAGE_BUCKET),
  );
}

/** Server-only adapter. Never expose SUPABASE_SERVICE_ROLE_KEY to mobile clients. */
export async function createSignedUpload(
  objectKey: string,
  expiresIn = 600,
): Promise<SignedUpload> {
  if (!configured())
    return {
      provider: "local",
      uploadUrl: `https://s3.local/${objectKey}`,
      objectKey,
      expiresIn,
    };
  const client = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await client.storage
    .from((process.env.SUPABASE_STORAGE_BUCKET ?? process.env.STORAGE_BUCKET)!)
    .createSignedUploadUrl(objectKey);
  if (error || !data)
    throw new Error(
      `Supabase signed upload failed: ${error?.message ?? "empty response"}`,
    );
  return {
    provider: "supabase",
    uploadUrl: data.signedUrl,
    token: data.token,
    objectKey,
    expiresIn,
  };
}

export function storageMode(): "supabase" | "local" {
  return configured() ? "supabase" : "local";
}
