import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createStoryframeServer } from "./app";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
try {
  loadEnvFile(envPath);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") {
    console.warn(`[storyframe] Could not load ${envPath} (${code ?? "unknown error"}).`);
  }
}

const production = process.env.NODE_ENV === "production";
const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT?.trim() || 8787);
const server = createStoryframeServer();

const hasPublishableKey = Boolean(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY);

server.listen(port, host, () => {
  console.log(
    `[storyframe] ${production ? "Server" : "Development AI server"} listening on http://${host}:${port}`,
  );
  console.log(`[storyframe] OLLAMA_API_KEY: ${process.env.OLLAMA_API_KEY ? "present" : "missing"}`);
  console.log(
    `[storyframe] Supabase auth: ${process.env.SUPABASE_URL && hasPublishableKey ? "configured" : "missing"}`,
  );
  console.log(
    `[storyframe] Usage ledger: ${
      process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
        ? "configured; readiness reported by /api/ai/status"
        : "missing"
    }`,
  );
  if (!production) {
    console.log("[storyframe] Development arrangement only - not a production hosting solution.");
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
