import { Pool } from "pg";

export type PersistenceMode = "sqlite" | "postgres";
export function persistenceMode(): PersistenceMode {
  return (process.env.DB_URL ?? process.env.SUPABASE_DB_URL)
    ? "postgres"
    : "sqlite";
}

export function validateRuntimeConfig(service: string) {
  const errors: string[] = [];
  if (process.env.NODE_ENV === "production" && !(process.env.DB_URL ?? process.env.SUPABASE_DB_URL)) {
    errors.push("DB_URL or SUPABASE_DB_URL is required in production");
  }
  if (process.env.STORAGE_PROVIDER === "supabase") {
    if (!process.env.SUPABASE_URL) errors.push("SUPABASE_URL is required when STORAGE_PROVIDER=supabase");
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) errors.push("SUPABASE_SERVICE_ROLE_KEY is required when STORAGE_PROVIDER=supabase");
    if (!(process.env.SUPABASE_STORAGE_BUCKET ?? process.env.STORAGE_BUCKET)) errors.push("SUPABASE_STORAGE_BUCKET is required when STORAGE_PROVIDER=supabase");
  }
  if (errors.length) throw new Error(`${service} runtime configuration invalid: ${errors.join("; ")}`);
}


/** Validates connectivity to the managed Postgres target before accepting traffic. */
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
      `${service} detected DB_URL/SUPABASE_DB_URL, but POSTGRES_ROUTES_ENABLED is not true. Refusing to mix the async Postgres route repository with SQLite.`,
    );
  }
  return checkPostgresConnection();
}
