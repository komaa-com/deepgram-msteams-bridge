import { isIP } from "node:net";
import { isForbiddenIp } from "./ssrf.js";
import { logger } from "./log.js";

/**
 * Bridge configuration, entirely from environment variables.
 * The worker-side contract (HMAC secret, wire protocol) must match the
 * StandIn media bridge; the Deepgram side needs an API key - the agent
 * itself (listen/think/speak, prompt, greeting) is configured per session
 * from the variables below, no dashboard required.
 */

const log = logger("config");

export interface BridgeConfig {
  /** TCP port the bridge listens on for worker WebSocket upgrades. */
  port: number;
  /** Bind address. */
  host: string;
  /** Must equal the shared secret the StandIn media bridge signs with (HMAC upgrade check). */
  workerSharedSecret: string;
  /** Server-side Deepgram key; opens Voice Agent sessions and calls Aura TTS. */
  deepgramApiKey: string;
  /** Voice Agent WebSocket host. Restricted to *.deepgram.com. */
  agentHost: string;
  /** REST API host (goodbye TTS). Restricted to *.deepgram.com. */
  apiHost: string;
  /** STT model for agent.listen (e.g. nova-3, flux-general-en). */
  listenModel: string;
  /** LLM provider for agent.think (e.g. open_ai, anthropic, google). */
  thinkProvider: string;
  /** LLM model for agent.think (e.g. gpt-4o-mini). */
  thinkModel: string;
  /** TTS voice model for agent.speak (e.g. aura-2-thalia-en). */
  speakModel: string;
  /**
   * BYO-LLM endpoint for agent.think - REQUIRED by Deepgram for third-party
   * think providers (google, groq, aws_bedrock, ...); Deepgram-managed
   * open_ai/anthropic work without it. Deepgram dials this URL itself.
   */
  thinkEndpointUrl: string | null;
  /** Headers for the think endpoint (JSON object, e.g. {"authorization": "Bearer ..."}). */
  thinkEndpointHeaders: Record<string, string> | null;
  /** Agent language (per Deepgram, e.g. "en"). */
  language: string;
  /** Base agent prompt. Null = a built-in default; per-call caller context is appended either way. */
  instructions: string | null;
  /** Deterministic opening line (Settings agent.greeting). Null = the agent opens naturally. */
  greeting: string | null;
  /** Aura model for the deterministic governor goodbye via standalone TTS (e.g. aura-2-thalia-en). Null = the goodbye is spoken by the live agent via InjectAgentMessage. */
  ttsModel: string | null;
  /** Vision path 2: OpenAI-compatible chat-completions URL for describe-then-answer. Null = the look tool reports vision unavailable. */
  visionApiUrl: string | null;
  /** Bearer key for the vision endpoint (optional - local endpoints may not need one). */
  visionApiKey: string | null;
  /** Vision model name (required when visionApiUrl is set). */
  visionModel: string | null;
  /**
   * Gate the look tool on Teams recording being active. Camera/screen frames
   * are PII-bearing; when true, the bridge refuses to send a frame to the
   * vision endpoint unless recording.status is "active".
   */
  visionRequiresRecording: boolean;
  /**
   * Bridge-side call governor: hard cap on call duration in minutes
   * (fractional allowed). 0 = disabled. Deepgram doesn't know about your
   * billing; on limit the bridge speaks a goodbye and ends the call.
   */
  maxCallMinutes: number;
  /** Goodbye line the governor speaks (deterministic via TTS when DEEPGRAM_TTS_MODEL is set). */
  goodbyeText: string;
  /** How long to let the goodbye play out before session.end when its duration is unknown (agent-spoken fallback). */
  goodbyeGraceMs: number;
  /** Allowed clock skew for the HMAC timestamp, in ms (worker side documents +-60s). */
  hmacFreshnessMs: number;
  /** Max concurrent worker connections (0 = default 64). */
  maxConnections: number;
  /** Max concurrent connections from one remote IP (0 = default: same as maxConnections, i.e. no per-IP throttle). */
  maxConnectionsPerIp: number;
  /** Drop a worker that authenticates but never sends session.start after this many ms (0 = default 10s). */
  preStartTimeoutMs: number;
  /** Dead-peer window: end the call after this many ms without ANY worker message (0 = default 90s; the worker heartbeats every 30s). */
  workerIdleTimeoutMs: number;
  /** Trust X-Forwarded-For for the per-IP cap (only behind a proxy you control). */
  trustProxy: boolean;
  /** PEM cert/key paths for native TLS (wss). When both are set the bridge serves HTTPS itself; otherwise it is plain WS and MUST be fronted by a TLS terminator. */
  tlsCertPath: string | null;
  tlsKeyPath: string | null;
  /** Log transcripts (ConversationText) - still gated on Teams recording.status === "active". */
  logTranscripts: boolean;
}

/**
 * DEEPGRAM_API_KEY is sent as `Authorization: Token ...` to these hosts, so an
 * attacker-influenced or fat-fingered host would exfiltrate the key. Restrict
 * both to Deepgram's own domain. Set DEEPGRAM_HOST_ALLOW_ANY=true only for a
 * deliberate proxy/test host.
 */
function validateDeepgramHost(name: string, host: string): string {
  if (process.env.DEEPGRAM_HOST_ALLOW_ANY === "true") {
    return host;
  }
  const h = host.toLowerCase();
  if (h === "deepgram.com" || h.endsWith(".deepgram.com")) {
    return host;
  }
  throw new Error(
    `${name} "${host}" is not a deepgram.com host; the API key must not be sent elsewhere. ` +
      `Set DEEPGRAM_HOST_ALLOW_ANY=true to override for a trusted proxy.`,
  );
}

/**
 * Vision path 2 sends caller video frames to VISION_API_URL, so validate it at
 * startup: it must be a well-formed http(s) URL with no embedded credentials.
 * A literal private/loopback IP is allowed (local Ollama/vLLM is a documented
 * use case) but WARNED about, so a fat-fingered internal host is visible.
 */
function validateVisionUrl(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`VISION_API_URL "${raw}" is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`VISION_API_URL "${raw}" must be http(s), not ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("VISION_API_URL must not contain embedded credentials");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isForbiddenIp(host)) {
    log.warn(
      `VISION_API_URL points at private/reserved address ${host} - fine for a local vision endpoint (Ollama/vLLM), ` +
        `but make sure this is intentional: caller video frames will be sent there`,
    );
  }
  return raw;
}

/**
 * The think endpoint is dialed BY DEEPGRAM (not this bridge), so the SSRF
 * posture is simply: https only, well-formed, no embedded credentials
 * (credentials belong in the headers object).
 */
function validateThinkEndpointUrl(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`DEEPGRAM_THINK_ENDPOINT_URL "${raw}" is not a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`DEEPGRAM_THINK_ENDPOINT_URL "${raw}" must be https (Deepgram dials it)`);
  }
  if (url.username || url.password) {
    throw new Error("DEEPGRAM_THINK_ENDPOINT_URL must not contain embedded credentials; use DEEPGRAM_THINK_ENDPOINT_HEADERS");
  }
  return raw;
}

/** Parse DEEPGRAM_THINK_ENDPOINT_HEADERS: a JSON object of string values. Fail loud on junk. */
function parseThinkEndpointHeaders(raw: string | null): Record<string, string> | null {
  if (!raw || !raw.trim()) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DEEPGRAM_THINK_ENDPOINT_HEADERS is not valid JSON (expected {"header": "value"})');
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DEEPGRAM_THINK_ENDPOINT_HEADERS must be a JSON object");
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new Error(`DEEPGRAM_THINK_ENDPOINT_HEADERS["${k}"] must be a string`);
    }
    headers[k] = v;
  }
  return headers;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var ${name}`);
  }
  return v.trim();
}

function optional(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

/**
 * Parse a numeric env var, failing LOUD on a non-numeric value. `Number("abc")`
 * is NaN, which silently disables the governor (MAX_CALL_MINUTES) or throws an
 * opaque listen error (PORT). A typo should stop startup with a clear message.
 */
function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Env var ${name}="${raw}" is not a number`);
  }
  // Fail loud on negatives too: e.g. MAX_CALL_MINUTES=-1 would pass Number.isFinite
  // and then `maxCallMinutes > 0` silently disables the governor - the same
  // silent-misconfig class numFromEnv exists to prevent. All these knobs are
  // counts/durations/minutes where a negative is never meaningful.
  if (n < 0) {
    throw new Error(`Env var ${name}="${raw}" must not be negative`);
  }
  return n;
}

export function loadConfig(): BridgeConfig {
  return {
    port: numFromEnv("PORT", 8080),
    host: process.env.BIND?.trim() || "0.0.0.0",
    workerSharedSecret: required("WORKER_SHARED_SECRET"),
    deepgramApiKey: required("DEEPGRAM_API_KEY"),
    agentHost: validateDeepgramHost("DEEPGRAM_AGENT_HOST", process.env.DEEPGRAM_AGENT_HOST?.trim() || "agent.deepgram.com"),
    apiHost: validateDeepgramHost("DEEPGRAM_API_HOST", process.env.DEEPGRAM_API_HOST?.trim() || "api.deepgram.com"),
    listenModel: process.env.DEEPGRAM_LISTEN_MODEL?.trim() || "nova-3",
    thinkProvider: process.env.DEEPGRAM_THINK_PROVIDER?.trim() || "open_ai",
    thinkModel: process.env.DEEPGRAM_THINK_MODEL?.trim() || "gpt-4o-mini",
    speakModel: process.env.DEEPGRAM_SPEAK_MODEL?.trim() || "aura-2-thalia-en",
    thinkEndpointUrl: validateThinkEndpointUrl(optional("DEEPGRAM_THINK_ENDPOINT_URL")),
    thinkEndpointHeaders: parseThinkEndpointHeaders(optional("DEEPGRAM_THINK_ENDPOINT_HEADERS")),
    language: process.env.DEEPGRAM_LANGUAGE?.trim() || "en",
    instructions: optional("DEEPGRAM_PROMPT"),
    greeting: optional("DEEPGRAM_GREETING"),
    ttsModel: optional("DEEPGRAM_TTS_MODEL"),
    maxCallMinutes: numFromEnv("MAX_CALL_MINUTES", 0),
    goodbyeText:
      process.env.GOODBYE_TEXT ??
      "I'm sorry, we've reached the time limit for this call. Thank you for calling, goodbye!",
    goodbyeGraceMs: numFromEnv("GOODBYE_GRACE_MS", 8000),
    visionApiUrl: validateVisionUrl(optional("VISION_API_URL")),
    visionApiKey: optional("VISION_API_KEY"),
    visionModel: optional("VISION_MODEL"),
    visionRequiresRecording: process.env.VISION_REQUIRES_RECORDING === "true",
    hmacFreshnessMs: numFromEnv("HMAC_FRESHNESS_MS", 60_000),
    maxConnections: numFromEnv("MAX_CONNECTIONS", 0),
    maxConnectionsPerIp: numFromEnv("MAX_CONNECTIONS_PER_IP", 0),
    preStartTimeoutMs: numFromEnv("PRE_START_TIMEOUT_MS", 0),
    workerIdleTimeoutMs: numFromEnv("WORKER_IDLE_TIMEOUT_MS", 0),
    trustProxy: process.env.TRUST_PROXY_XFF === "true",
    tlsCertPath: optional("TLS_CERT_PATH"),
    tlsKeyPath: optional("TLS_KEY_PATH"),
    logTranscripts: process.env.LOG_TRANSCRIPTS === "true",
  };
}
