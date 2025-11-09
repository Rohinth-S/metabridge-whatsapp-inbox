import { Pool } from "pg";

export type PersistenceMode = "sqlite" | "postgres";
export function persistenceMode(): PersistenceMode {
  return (process.env.DB_URL ?? process.env.SUPABASE_DB_URL)
    ? "postgres"
    : "sqlite";
}

export function validateRuntimeConfig(service: string) {
  const errors: string[] = [];
  if (
    process.env.NODE_ENV === "production" &&
    !(process.env.DB_URL ?? process.env.SUPABASE_DB_URL)
  )
    errors.push("DB_URL is required in production");
  if (process.env.NODE_ENV === "production" && !process.env.SUPABASE_URL)
    errors.push("SUPABASE_URL is required in production");
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  )
    errors.push("SUPABASE_SERVICE_ROLE_KEY is required in production");
  if (
    process.env.NODE_ENV === "production" &&
    !(process.env.SUPABASE_STORAGE_BUCKET ?? process.env.STORAGE_BUCKET)
  )
    errors.push("SUPABASE_STORAGE_BUCKET is required in production");
  if (errors.length)
    throw new Error(
      `${service} runtime configuration invalid: ${errors.join("; ")}`,
    );
}

/**
 * Validates connectivity to the managed Postgres target. Route repositories still
 * use the local synchronous adapter until the async repository migration is enabled.
 */
export async function checkPostgresConnection() {
  if (!(process.env.DB_URL ?? process.env.SUPABASE_DB_URL))
    return { mode: "sqlite" as const, checked: false };
  const pool = new Pool({
    connectionString: process.env.DB_URL ?? process.env.SUPABASE_DB_URL,
    ssl:
      process.env.PGSSLMODE === "disable"
        ? undefined
        : { rejectUnauthorized: false },
    max: 2,
  });
  try {
    await pool.query("select 1 as ok");
    return { mode: "postgres" as const, checked: true };
  } finally {
    await pool.end();
  }
}

export async function bootstrapPersistence(service: string) {
  validateRuntimeConfig(service);
  if (
    persistenceMode() === "postgres" &&
    process.env.POSTGRES_ROUTES_ENABLED !== "true"
  ) {
    throw new Error(
      `${service} detected DB_URL/SUPABASE_DB_URL, but route repositories still use the synchronous SQLite adapter. Complete the async Postgres repository migration before enabling POSTGRES_ROUTES_ENABLED=true.`,
    );
  }
  return checkPostgresConnection();
}
