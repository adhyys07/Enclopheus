import dotenv from "dotenv";
import pkg from "pg";
const { Pool } = pkg;

dotenv.config({ quiet: true });

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;

  try {
    const parsed = new URL(rawUrl);
    const sslmode = (parsed.searchParams.get("sslmode") || "").toLowerCase();

    // Explicitly pin secure behavior to avoid future pg/libpq semantic changes.
    if (sslmode === "prefer" || sslmode === "require" || sslmode === "verify-ca") {
      parsed.searchParams.set("sslmode", "verify-full");
      return parsed.toString();
    }

    return rawUrl;
  } catch {
    return rawUrl;
  }
}

export const pool = new Pool({
  connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL),
});
