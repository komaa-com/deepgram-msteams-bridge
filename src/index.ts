/**
 * @komaa/deepgram-msteams-bridge - public API.
 *
 * Typical embedding:
 *   import { loadConfig, startServer } from "@komaa/deepgram-msteams-bridge";
 *   startServer(loadConfig());
 *
 * Or run the CLI: `npx @komaa/deepgram-msteams-bridge` (env-configured, see .env.example).
 */

export { loadConfig, type BridgeConfig } from "./config.js";
export { startServer, authorizeUpgrade, callIdFromUrl, ReplayGuard, type StartServerOptions } from "./server.js";
export { CallSession, type DgConnector } from "./session.js";
export { makeVisionDescriber, type VisionDescriber } from "./vision.js";
export { assertPublicHttpUrl, isForbiddenIp, readBodyWithCap, fetchPublicImage } from "./ssrf.js";
export { renderMetrics } from "./metrics.js";
export {
  DeepgramAgentSocket,
  buildSettings,
  buildPrompt,
  synthesizeGoodbye,
  customToolSchema,
  BRIDGE_FUNCTIONS,
  WIRE_SAMPLE_RATE,
  type AgentPort,
  type CustomTool,
  type CustomToolContext,
  type CustomToolHandler,
  type DgInbound,
  type DgSessionHandlers,
  type SettingsOptions,
  type CallerContext,
} from "./deepgram.js";
export { sign, verify, isFresh, TIMESTAMP_HEADER, SIGNATURE_HEADER, LEGACY_TIMESTAMP_HEADER, LEGACY_SIGNATURE_HEADER } from "./hmac.js";
export * from "./protocol.js";
export { logger, type Logger } from "./log.js";
