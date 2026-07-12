import WebSocket from "ws";
import type { BridgeConfig } from "./config.js";
import type { Logger } from "./log.js";

/**
 * Deepgram Voice Agent WebSocket client + the one REST call the bridge needs
 * (standalone Aura TTS for the deterministic governor goodbye).
 *
 * Wire reference (validated 2026-07-12 against the Voice Agent API docs):
 * the client connects to wss://{host}/v1/agent/converse with
 * `Authorization: Token <api key>`, waits for `Welcome`, then sends a
 * `Settings` message configuring audio in/out (linear16 at 16 kHz both ways -
 * the StandIn wire rate, so the hot path is COPY-ONLY, no resampling) and the
 * agent (listen/think/speak providers, prompt, greeting, functions).
 * Caller audio is sent as RAW BINARY frames; agent audio arrives as raw
 * binary frames. JSON events ride the same socket: UserStartedSpeaking
 * (barge-in), FunctionCallRequest/FunctionCallResponse (client-side tools),
 * ConversationText (transcripts), InjectAgentMessage / InjectUserMessage /
 * UpdatePrompt (client -> server), KeepAlive, Error/Warning.
 */

/** The one wire rate: StandIn PCM 16 kHz mono = Deepgram linear16 @ 16000. */
export const WIRE_SAMPLE_RATE = 16_000;

/** Client keep-alive cadence (the Voice Agent socket idles out without it). */
const KEEPALIVE_INTERVAL_MS = 8_000;

/** Time bound on the REST TTS call and the WS handshake, so a hung endpoint
 *  can never wedge a call open. */
const DG_REST_TIMEOUT_MS = 10_000;

/** How long to wait for the server's Welcome after the socket opens. */
const WELCOME_TIMEOUT_MS = 10_000;

// ---- server -> client event shapes (subset the bridge consumes) ----

export interface DgWelcome {
  type: "Welcome";
  request_id?: string;
}

export interface DgSettingsApplied {
  type: "SettingsApplied";
}

export interface DgConversationText {
  type: "ConversationText";
  role?: string;
  content?: string;
}

export interface DgUserStartedSpeaking {
  type: "UserStartedSpeaking";
}

export interface DgAgentStartedSpeaking {
  type: "AgentStartedSpeaking";
}

export interface DgAgentAudioDone {
  type: "AgentAudioDone";
}

export interface DgFunctionCall {
  id?: string;
  name?: string;
  /** JSON-encoded string per the docs; tolerate an already-parsed object. */
  arguments?: string | Record<string, unknown>;
  client_side?: boolean;
}

export interface DgFunctionCallRequest {
  type: "FunctionCallRequest";
  functions?: DgFunctionCall[];
}

export interface DgInjectionRefused {
  type: "InjectionRefused";
  message?: string;
}

export interface DgError {
  type: "Error";
  description?: string;
  code?: string;
}

export interface DgWarning {
  type: "Warning";
  description?: string;
}

export type DgInbound =
  | DgWelcome
  | DgSettingsApplied
  | DgConversationText
  | DgUserStartedSpeaking
  | DgAgentStartedSpeaking
  | DgAgentAudioDone
  | DgFunctionCallRequest
  | DgInjectionRefused
  | DgError
  | DgWarning
  | { type: string; [k: string]: unknown };

// ---- built-in bridge functions ----

/** A Settings agent.think.functions entry (no endpoint = client-side, answered by this bridge). */
export interface DgFunctionSchema {
  name: string;
  description: string;
  /** JSON schema for the parameters ({type: "object", properties, required}). */
  parameters: Record<string, unknown>;
}

/**
 * Client-side functions registered on every session (declared in Settings
 * under agent.think.functions; entries WITHOUT an endpoint are executed by
 * this client via FunctionCallRequest/FunctionCallResponse). The bridge
 * implements their behavior; nothing to configure on the Deepgram side.
 */
export const BRIDGE_FUNCTIONS: DgFunctionSchema[] = [
  {
    name: "end_call",
    description:
      "Hang up the call. Call this when the conversation is finished, the caller says goodbye, or the caller asks you to hang up.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "express",
    description:
      "Show an emotion on your avatar's face. Use it to react naturally (e.g. happy when greeting, surprised at unexpected news).",
    parameters: {
      type: "object",
      properties: {
        emotion: { type: "string", description: "The emotion to express, e.g. happy, sad, surprised, neutral." },
      },
      required: ["emotion"],
    },
  },
  {
    name: "show_image",
    description:
      "Show an image to the caller on your video tile. Provide a public https image URL (jpeg or png). Use it when a visual would help.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public https URL of a jpeg/png image." },
        caption: { type: "string", description: "Optional short caption." },
      },
      required: ["url"],
    },
  },
  {
    name: "look",
    description:
      "Look at the caller's camera or shared screen and get a text description of what is visible. Use it when the caller refers to something they are showing you.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: 'Which video to look at: "camera" or "screenshare".' },
        question: { type: "string", description: "What you want to know about the video." },
      },
      required: [],
    },
  },
];

// ---- tool extensibility ----

/** Per-call context handed to custom tool handlers. */
export interface CustomToolContext {
  callId: string;
  participantCount: number;
  recordingActive: boolean;
  log: Logger;
}

/**
 * A custom client-side function the BRIDGE executes: the agent calls it, the
 * handler runs in your process, and the returned string goes back as the
 * FunctionCallResponse content. Keep handlers fast - the model (and the
 * caller) is waiting on the result; enforce your own timeout for slow
 * backends.
 */
export type CustomToolHandler = (params: Record<string, unknown>, ctx: CustomToolContext) => string | Promise<string>;

export interface CustomTool {
  /** Function name the agent calls. Must not collide with the built-in bridge functions. */
  name: string;
  description: string;
  /** JSON schema for the parameters ({type: "object", properties, required}). */
  parameters: Record<string, unknown>;
  handler: CustomToolHandler;
}

/** The Settings functions entry for a custom tool (schema only; the handler stays bridge-side). */
export function customToolSchema(tool: CustomTool): DgFunctionSchema {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

// ---- Settings / prompt builders ----

const DEFAULT_INSTRUCTIONS =
  "You are a helpful voice assistant on a live Microsoft Teams call. You are speaking aloud: keep replies short, natural and conversational, and never use markdown, lists or emoji.";

export interface CallerContext {
  callerName: string;
  tenantId: string;
  direction: string;
}

/**
 * The agent prompt: configured base instructions (or the default), per-call
 * caller context, and any live context notes (participants, DTMF, active
 * speaker) appended as a bounded rolling section - the Voice Agent API has no
 * non-interrupting context message, so context rides UpdatePrompt instead.
 */
export function buildPrompt(base: string | null, caller: CallerContext, contextNotes: string[] = []): string {
  const lines = [
    base?.trim() || DEFAULT_INSTRUCTIONS,
    "",
    `Call context: you are speaking with ${caller.callerName} (tenant: ${caller.tenantId}) on an ${caller.direction} call.`,
  ];
  if (contextNotes.length > 0) {
    lines.push("", "Live call context (most recent last):");
    for (const note of contextNotes) {
      lines.push(`- ${note}`);
    }
  }
  return lines.join("\n");
}

export interface SettingsOptions {
  /** Full prompt from buildPrompt() (base + caller context + notes). */
  prompt: string;
  language: string;
  listenModel: string;
  thinkProvider: string;
  thinkModel: string;
  speakModel: string;
  /**
   * BYO-LLM endpoint for agent.think - REQUIRED by Deepgram for third-party
   * think providers (e.g. google, groq, aws_bedrock); Deepgram-managed
   * open_ai/anthropic work without it. Null = omitted.
   */
  thinkEndpointUrl: string | null;
  /** Headers for the think endpoint (e.g. {authorization: "Bearer ..."}). */
  thinkEndpointHeaders: Record<string, string> | null;
  /** Deterministic opening line the agent speaks first. Omitted when null. */
  greeting: string | null;
  /** Extra client-side function schemas merged after the built-ins. */
  extraFunctions?: DgFunctionSchema[];
}

/**
 * The Settings message sent once per call, right after Welcome. Audio is
 * pinned to linear16 @ 16 kHz both ways (the StandIn wire rate - copy-only
 * relay, no transcoding), container "none" (raw frames).
 */
export function buildSettings(opts: SettingsOptions): Record<string, unknown> {
  // language lives on the listen/speak providers (the top-level agent.language
  // field is deprecated in the Voice Agent API).
  const think: Record<string, unknown> = {
    provider: { type: opts.thinkProvider, model: opts.thinkModel },
    prompt: opts.prompt,
    functions: [...BRIDGE_FUNCTIONS, ...(opts.extraFunctions ?? [])],
  };
  if (opts.thinkEndpointUrl) {
    think.endpoint = {
      url: opts.thinkEndpointUrl,
      ...(opts.thinkEndpointHeaders ? { headers: opts.thinkEndpointHeaders } : {}),
    };
  }
  const agent: Record<string, unknown> = {
    listen: { provider: { type: "deepgram", model: opts.listenModel, language: opts.language } },
    think,
    speak: { provider: { type: "deepgram", model: opts.speakModel, language: opts.language } },
  };
  if (opts.greeting) {
    agent.greeting = opts.greeting;
  }
  return {
    type: "Settings",
    audio: {
      input: { encoding: "linear16", sample_rate: WIRE_SAMPLE_RATE },
      output: { encoding: "linear16", sample_rate: WIRE_SAMPLE_RATE, container: "none" },
    },
    agent,
  };
}

// ---- REST helper (deterministic goodbye TTS) ----

/**
 * Standalone Aura TTS for the deterministic governor goodbye: synthesize the
 * exact text as raw linear16 @ 16 kHz and return the bytes. Only used when
 * DEEPGRAM_TTS_MODEL is set; the fallback speaks through the live agent via
 * InjectAgentMessage instead.
 */
export async function synthesizeGoodbye(cfg: BridgeConfig, text: string): Promise<Buffer> {
  if (!cfg.ttsModel) {
    throw new Error("DEEPGRAM_TTS_MODEL not configured");
  }
  const url = new URL(`https://${cfg.apiHost}/v1/speak`);
  url.searchParams.set("model", cfg.ttsModel);
  url.searchParams.set("encoding", "linear16");
  url.searchParams.set("sample_rate", String(WIRE_SAMPLE_RATE));
  url.searchParams.set("container", "none");
  // Time-bound the synth: the governor's hard teardown deadline is armed before
  // this is awaited, but a fetch that hangs forever would still hold the promise
  // (and the mute latch) open.
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Token ${cfg.deepgramApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(DG_REST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`TTS failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---- Voice Agent WebSocket session ----

export interface DgSessionHandlers {
  /** JSON events (Welcome/SettingsApplied are consumed by the socket itself). */
  onMessage: (msg: DgInbound) => void;
  /** Agent audio: raw binary linear16 @ 16 kHz frames. */
  onAudio: (pcm: Buffer) => void;
  onClose: (code: number, reason: string) => void;
  onError: (err: Error) => void;
}

/** What the relay needs from an agent connection; DeepgramAgentSocket is the real one, tests fake it. */
export interface AgentPort {
  readonly isOpen: boolean;
  /** Caller audio: base64 PCM 16 kHz from the wire, sent as a raw binary frame. */
  sendAudioChunk(base64Pcm: string): void;
  /** The one-time Settings message (audio formats, agent config, functions). */
  sendSettings(settings: Record<string, unknown>): void;
  /** Replace the agent's prompt mid-call (live context notes ride this). */
  updatePrompt(prompt: string): void;
  /** Make the agent speak this exact text (goodbye fallback). May be refused while the agent is mid-utterance. */
  injectAgentMessage(text: string): void;
  /** Answer a client-side FunctionCallRequest. */
  sendFunctionCallResponse(id: string, name: string, content: string): void;
  close(): void;
}

/** One Voice Agent socket. Thin: parsing + send helpers only; relay logic lives in session.ts. */
export class DeepgramAgentSocket implements AgentPort {
  private ws: WebSocket;
  private readonly log: Logger;
  private keepAlive: NodeJS.Timeout | null = null;

  private constructor(ws: WebSocket, log: Logger) {
    this.ws = ws;
    this.log = log;
  }

  /**
   * Open the agent WS and wire handlers. Resolves once the server's Welcome
   * has arrived (the Settings message may be sent from then on). One retry on
   * a transient connect failure.
   */
  static async connect(cfg: BridgeConfig, log: Logger, handlers: DgSessionHandlers): Promise<DeepgramAgentSocket> {
    let ws: WebSocket;
    try {
      ws = await DeepgramAgentSocket.openOnce(cfg);
    } catch (err) {
      log.warn(`Deepgram connect failed (${(err as Error).message}); retrying once`);
      await new Promise((r) => setTimeout(r, 250));
      ws = await DeepgramAgentSocket.openOnce(cfg);
    }
    const sock = new DeepgramAgentSocket(ws, log);

    ws.on("message", (data, isBinary) => {
      // Agent audio is raw binary; JSON events are text frames.
      if (isBinary) {
        try {
          handlers.onAudio(data as Buffer);
        } catch (err) {
          log.error(`error handling agent audio: ${(err as Error).message}`);
        }
        return;
      }
      let msg: DgInbound | null = null;
      try {
        msg = JSON.parse(data.toString("utf8")) as DgInbound;
      } catch {
        log.warn("Deepgram sent an unparseable text frame; dropping");
        return;
      }
      try {
        handlers.onMessage(msg);
      } catch (err) {
        // Never let a handler throw escape the ws listener - that is an
        // uncaught exception and takes the whole process (all calls) down.
        log.error(`error handling Deepgram ${msg.type}: ${(err as Error).message}`);
      }
    });
    ws.on("close", (code, reason) => {
      sock.stopKeepAlive();
      handlers.onClose(code, reason.toString("utf8"));
    });
    ws.on("error", (err) => handlers.onError(err as Error));

    // The socket idles out without periodic KeepAlive when no audio is flowing
    // (hold music, silence). Cheap; sent for the lifetime of the call.
    sock.keepAlive = setInterval(() => sock.send({ type: "KeepAlive" }), KEEPALIVE_INTERVAL_MS);
    sock.keepAlive.unref?.();
    return sock;
  }

  /** Open the socket once and wait for the server's Welcome; rejects on any failure. */
  private static async openOnce(cfg: BridgeConfig): Promise<WebSocket> {
    const url = `wss://${cfg.agentHost}/v1/agent/converse`;
    // Bound the WS open: without handshakeTimeout, a blackholed TCP connect or
    // a stalled TLS/upgrade handshake would hang onSessionStart forever (the
    // governor is only armed after connect).
    const ws = new WebSocket(url, {
      headers: { authorization: `Token ${cfg.deepgramApiKey}` },
      handshakeTimeout: DG_REST_TIMEOUT_MS,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no Welcome from Deepgram within the timeout")), WELCOME_TIMEOUT_MS);
        timer.unref?.();
        const onError = (err: Error): void => {
          clearTimeout(timer);
          reject(err);
        };
        const onCloseEarly = (code: number): void => {
          clearTimeout(timer);
          reject(new Error(`socket closed before Welcome (${code})`));
        };
        const onMessage = (data: Buffer, isBinary: boolean): void => {
          if (isBinary) {
            return; // audio cannot arrive before Settings; ignore defensively
          }
          try {
            const msg = JSON.parse(data.toString("utf8")) as { type?: string };
            if (msg.type === "Welcome") {
              clearTimeout(timer);
              // Remove ALL handshake listeners: a stale once("close") would
              // otherwise fire (a no-op reject on a settled promise) during
              // every normal teardown, and a stale once("error") would race
              // the real handler wired by connect().
              ws.off("message", onMessage);
              ws.off("error", onError);
              ws.off("close", onCloseEarly);
              resolve();
            }
          } catch {
            /* ignore junk before Welcome */
          }
        };
        ws.on("message", onMessage);
        ws.once("error", onError);
        ws.once("close", onCloseEarly);
      });
    } catch (err) {
      // The rejected socket is now orphaned. Without a permanent 'error'
      // listener a later error event (TCP reset on the half-open socket) is an
      // uncaught EventEmitter 'error' -> the whole process (all live calls)
      // crashes. Neutralize it before discarding.
      ws.on("error", () => {});
      try {
        ws.terminate();
      } catch {
        /* already dead */
      }
      throw err;
    }
    return ws;
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  private send(obj: Record<string, unknown>): void {
    if (this.isOpen) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /** Caller audio -> agent, as a raw binary frame (base64 wire payload decoded, no transcoding). */
  sendAudioChunk(base64Pcm: string): void {
    if (this.isOpen) {
      this.ws.send(Buffer.from(base64Pcm, "base64"));
    }
  }

  sendSettings(settings: Record<string, unknown>): void {
    this.send(settings);
  }

  updatePrompt(prompt: string): void {
    this.send({ type: "UpdatePrompt", prompt });
  }

  injectAgentMessage(text: string): void {
    this.send({ type: "InjectAgentMessage", message: text });
  }

  sendFunctionCallResponse(id: string, name: string, content: string): void {
    this.send({ type: "FunctionCallResponse", id, name, content });
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }

  close(): void {
    this.stopKeepAlive();
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000, "session-end");
    }
  }
}
