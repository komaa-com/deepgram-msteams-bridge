#!/usr/bin/env node
/**
 * CLI entry point: `deepgram-msteams-bridge` (or `npx @komaa/deepgram-msteams-bridge`).
 * Entirely env-configured - see .env.example in the package root.
 */
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

try {
  // handleSignals: the CLI owns the process, so SIGTERM/SIGINT drain every live
  // call gracefully and then exit. (Embedders: this is opt-in for a reason - a
  // library must never call process.exit on its host.)
  const server = startServer(loadConfig(), undefined, undefined, { handleSignals: true });
  // listen() errors are ASYNC (e.g. EADDRINUSE) - without this handler they
  // crash with an opaque uncaught exception instead of the friendly hint below.
  server.on("error", (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      console.error(`deepgram-msteams-bridge: port already in use (${e.message}). Set PORT to a free port.`);
    } else {
      console.error(`deepgram-msteams-bridge: server error: ${e.message}`);
    }
    process.exit(1);
  });
} catch (err) {
  console.error(`deepgram-msteams-bridge: ${(err as Error).message}`);
  console.error("Required env: DEEPGRAM_API_KEY, WORKER_SHARED_SECRET (see .env.example).");
  process.exit(1);
}
