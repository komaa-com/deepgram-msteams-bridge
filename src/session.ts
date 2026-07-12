import type WebSocket from "ws";
import type { BridgeConfig } from "./config.js";
import { logger, type Logger } from "./log.js";
import {
  parseWorkerMessage,
  pcm16kBytesToMs,
  type AudioFrameMessage,
  type SessionStartMessage,
  type VideoFrameMessage,
  type WorkerOutbound,
} from "./protocol.js";
import {
  buildPrompt,
  buildSettings,
  customToolSchema,
  synthesizeGoodbye,
  DeepgramAgentSocket,
  type AgentPort,
  type CallerContext,
  type CustomTool,
  type DgConversationText,
  type DgError,
  type DgFunctionCall,
  type DgFunctionCallRequest,
  type DgInbound,
  type DgSessionHandlers,
  type DgWarning,
} from "./deepgram.js";
import { makeVisionDescriber, type VisionDescriber } from "./vision.js";
import { fetchPublicImage } from "./ssrf.js";
import { metricInc, metricObserve } from "./metrics.js";

/** show_image fetch cap: display.image goes to a small video tile; 5 MB is generous. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Pending caller-audio cap while Deepgram connects: 250 x 20 ms = 5 s. */
const MAX_PENDING_AUDIO_FRAMES = 250;

/** 20 ms of PCM 16 kHz mono 16-bit = 16000 * 0.02 * 2 = 640 bytes (one hot-path frame). */
const PCM16K_FRAME_BYTES = 640;

/** Outbound (bridge->worker) send-buffer cap. Above this, drop realtime frames
 *  instead of letting a stalled worker balloon memory. Matches the siblings. */
const MAX_OUTBOUND_BUFFER_BYTES = 1 * 1024 * 1024;

/** Live context notes kept in the prompt (participants/dtmf/speaker), most recent last. */
const MAX_CONTEXT_NOTES = 8;

/** Extra headroom on top of the goodbye grace before the governor force-ends the
 *  call, so a hung TTS synth can never wedge a time-limited call open. */
const GOODBYE_HARD_CAP_MS = 8_000;

/** Min gap between "now speaking" context notes (group calls), so VAD
 *  flapping between speakers cannot spam the agent. */
const SPEAKER_UPDATE_MIN_INTERVAL_MS = 5_000;

/** Dead-peer window: worker heartbeats every 30 s -> 3 missed pings ends the call. */
const DEFAULT_WORKER_IDLE_TIMEOUT_MS = 90_000;

/** Inline show_image dataBase64 cap - same 5 MB bound as the URL path,
 *  expressed in base64 characters (4 chars per 3 bytes). */
const MAX_INLINE_IMAGE_B64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/** Bounds on agent-supplied strings relayed to the worker as control frames,
 *  so a misbehaving model cannot emit multi-MB frames. */
const MAX_EMOTION_CHARS = 64;
const MAX_CAPTION_CHARS = 500;
const MAX_MODE_CHARS = 32;

/** Injectable Deepgram connector so tests can substitute a fake agent. */
export type DgConnector = (cfg: BridgeConfig, log: Logger, handlers: DgSessionHandlers) => Promise<AgentPort>;

/**
 * One Teams call: pairs the worker WebSocket with one Deepgram Voice Agent
 * session and relays between them.
 *
 * Audio is relayed VERBATIM in both directions - the wire is base64 PCM
 * 16 kHz and the Voice Agent session is pinned to linear16 @ 16 kHz, so the
 * hot path is copy-only (base64 <-> binary framing, no transcoding).
 */
export class CallSession {
  private readonly cfg: BridgeConfig;
  private readonly worker: WebSocket;
  private readonly log: Logger;
  private readonly connectDg: DgConnector;
  private readonly vision: VisionDescriber | null;
  /** Custom client-side functions the bridge executes (registered by the embedder). */
  private readonly customTools: Map<string, CustomTool>;

  private dg: AgentPort | null = null;
  private callId: string;
  private closed = false;
  /** Call start, for bridge_call_seconds_total at teardown. */
  private readonly startMs = Date.now();

  // outbound audio bookkeeping (bridge -> worker)
  private outSeq = 0;
  private outTimestampMs = 0;
  // backpressure-warn throttle (avoid ~50 warn lines/s when a worker stalls)
  private droppedFrames = 0;
  private lastBackpressureWarnMs = 0;

  // Barge-in ghost filter: on UserStartedSpeaking, Deepgram stops generating
  // TTS server-side, but frames already in flight on the socket still arrive.
  // Drop agent audio from the cut until the agent audibly starts its NEXT
  // utterance (AgentStartedSpeaking) - state-based, so it cannot leak memory
  // no matter how often the caller barges in.
  private droppingAgentAudio = false;
  // hard mute: set ONLY while a deterministic TTS goodbye plays (never for the
  // agent-spoken fallback, where the injected goodbye must stay audible)
  private muteAgentAudio = false;
  // first goodbye wins: both governors (worker assistant.say + bridge time limit) can race
  private goodbyeInProgress = false;
  // group-call speaker attribution: last name surfaced + a rate limit so VAD flapping can't spam
  private lastSpeakerName: string | null = null;
  private lastSpeakerUpdateMs = 0;
  private participantCount = 1;
  // Caller audio buffered until the session is READY: from session.start
  // through connect AND the server's SettingsApplied ack. The documented flow
  // is explicit - no audio before SettingsApplied.
  private pendingAudio: string[] = [];
  private sessionStarted = false;
  private settingsApplied = false;
  // bound the SettingsApplied wait: a hung Settings application must not leave
  // the call open and silent forever
  private settingsTimer: NodeJS.Timeout | null = null;
  // per-call caller context for prompt (re)builds
  private callerCtx: CallerContext | null = null;
  // live context notes (participants/dtmf/speaker) carried in the prompt - the
  // Voice Agent API has no non-interrupting context message, so context rides
  // UpdatePrompt. Bounded: oldest notes fall off.
  private contextNotes: string[] = [];

  // Teams recording gate: transcripts may be logged/persisted only when "active"
  private recordingActive = false;

  // vision groundwork: latest inbound frame per source, memory only
  private readonly latestVideoFrame = new Map<string, VideoFrameMessage>();

  // bridge-side call governor
  private governorTimer: NodeJS.Timeout | null = null;
  // hard-bounded teardown timer for the goodbye grace (so a hung TTS can't wedge the call open)
  private goodbyeTimer: NodeJS.Timeout | null = null;
  // invoked exactly once when the session tears down (server uses it to de-register)
  private readonly onClosed: (() => void) | undefined;

  // Dead-peer detection: the worker heartbeats every 30 s, but a half-open TCP
  // socket (NAT timeout, node crash, network drop without FIN) delivers nothing
  // and never fires 'close' - the session would stay "live" for hours, holding
  // the billed Voice Agent session open AND 409-blocking every reconnect for
  // this callId. Track the last inbound worker message and tear down after the
  // idle window (default 90 s = 3 missed heartbeats).
  private lastWorkerActivityMs = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    cfg: BridgeConfig,
    worker: WebSocket,
    callId: string,
    connectDg: DgConnector = DeepgramAgentSocket.connect,
    vision: VisionDescriber | null = makeVisionDescriber(cfg),
    onClosed?: () => void,
    customTools: CustomTool[] = [],
  ) {
    this.cfg = cfg;
    this.worker = worker;
    this.callId = callId;
    this.log = logger(`call:${callId.slice(0, 12)}`);
    this.connectDg = connectDg;
    this.vision = vision;
    this.customTools = new Map(customTools.map((t) => [t.name, t]));
    this.onClosed = onClosed;

    worker.on("message", (data) => {
      this.lastWorkerActivityMs = Date.now(); // any inbound frame proves the peer is alive
      // parity with the Deepgram side: a handler throw must not escape the ws
      // listener (uncaught exception -> process down)
      try {
        this.onWorkerMessage(data as Buffer);
      } catch (err) {
        this.log.error(`error handling worker message: ${(err as Error).message}`);
      }
    });
    worker.on("close", () => this.teardown("worker-closed"));
    worker.on("error", (err) => {
      this.log.warn(`worker socket error: ${(err as Error).message}`);
      this.teardown("worker-error");
    });

    const idleMs = cfg.workerIdleTimeoutMs > 0 ? cfg.workerIdleTimeoutMs : DEFAULT_WORKER_IDLE_TIMEOUT_MS;
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastWorkerActivityMs > idleMs) {
        this.log.warn(`no worker message in ${idleMs}ms (dead peer?); ending the call`);
        this.endCall("worker-idle-timeout");
      }
    }, Math.max(20, Math.min(idleMs / 3, 30_000)));
    this.idleTimer.unref?.();
  }

  /** Whether session.start has arrived (the server's pre-start timer asks). */
  get hasStarted(): boolean {
    return this.sessionStarted;
  }

  // ---- worker -> bridge ----

  private onWorkerMessage(data: Buffer): void {
    const msg = parseWorkerMessage(data);
    if (!msg) {
      this.log.warn("unparseable worker frame; dropping");
      return;
    }
    switch (msg.type) {
      case "session.start":
        this.onSessionStart(msg).catch((err) =>
          this.log.error(`session.start handling failed: ${(err as Error).message}`),
        );
        break;
      case "audio.frame":
        // hot path: caller audio -> agent, verbatim (base64 -> binary frame).
        // Until the server acks Settings (SettingsApplied), buffer (bounded)
        // instead of sending: the documented flow forbids audio before the
        // ack, and this window also covers the connect itself.
        if (this.dg && this.settingsApplied) {
          this.dg.sendAudioChunk(msg.payloadBase64);
          metricInc("bridge_frames_to_agent_total");
          this.noteSpeaker(msg.speakerName);
        } else if (this.sessionStarted) {
          this.pendingAudio.push(msg.payloadBase64);
          if (this.pendingAudio.length > MAX_PENDING_AUDIO_FRAMES) {
            this.pendingAudio.shift(); // keep the most recent speech
          }
        }
        break;
      case "ping":
        this.sendToWorker({ type: "pong", ts: msg.ts });
        break;
      case "participants":
        this.participantCount = msg.count;
        this.pushContext(
          msg.count <= 1
            ? "This is a 1:1 call with a single human caller."
            : `There are ${msg.count} human participants on this call. Stay quiet unless directly addressed.`,
        );
        break;
      case "dtmf":
        this.pushContext(`The caller pressed the "${msg.digit}" key on their keypad.`);
        break;
      case "recording.status":
        this.recordingActive = msg.status === "active";
        this.log.info(`recording.status = ${msg.status}`);
        break;
      case "video.frame":
        // Known sources only (camera/screenshare): the key comes from the peer, so an
        // unexpected value must not grow the map unbounded.
        if (msg.source === "camera" || msg.source === "screenshare") {
          this.latestVideoFrame.set(msg.source, msg); // buffered for on-demand vision; not persisted
        } else {
          this.log.debug(`ignoring video.frame with unknown source "${msg.source}"`);
        }
        break;
      case "assistant.say":
        // worker-side governor: speak, the worker tears down afterwards
        this.performGoodbye(msg.text).catch((err) =>
          this.log.error(`goodbye failed: ${(err as Error).message}`),
        );
        break;
      case "session.end":
        this.log.info(`session.end from worker: ${msg.reason}`);
        this.teardown("worker-session-end");
        break;
      default:
        this.log.debug(`ignoring worker message type ${(msg as { type: string }).type}`);
    }
  }

  private async onSessionStart(msg: SessionStartMessage): Promise<void> {
    if (this.sessionStarted) {
      // A second session.start would orphan the first Voice Agent session; the
      // worker sends exactly one per connection, so treat a repeat as a
      // protocol error.
      this.log.warn("duplicate session.start ignored");
      return;
    }
    this.sessionStarted = true;
    if (msg.callId && msg.callId !== this.callId) {
      // must match the HMAC-authenticated callId in the URL path (wire contract).
      // Use endCall so the worker gets a session.end (clean reason) rather than a
      // bare socket close it would log as an unexpected drop.
      this.log.error(`session.start callId ${msg.callId} != URL callId ${this.callId}; closing`);
      this.endCall("callid-mismatch");
      return;
    }
    this.log.info(`session.start (direction=${msg.direction ?? "inbound"}, recording=${msg.recordingStatus ?? "unknown"})`);
    this.recordingActive = msg.recordingStatus === "active";
    // Per-call personalization: caller context lives in the prompt.
    // CallerInfo fields are all nullable - default, never send null.
    this.callerCtx = {
      callerName: msg.caller?.displayName?.trim() || "caller",
      tenantId: msg.caller?.tenantId?.trim() || "unknown-tenant",
      direction: msg.direction?.trim() || "inbound",
    };

    let dg: AgentPort;
    try {
      dg = await this.connectDg(this.cfg, this.log, {
        onMessage: (m) => this.onDgMessage(m),
        onAudio: (pcm) => this.onDgAudio(pcm),
        onClose: (code, reason) => {
          this.log.info(`Deepgram socket closed (${code} ${reason})`);
          this.endCall("agent-disconnected");
        },
        onError: (err) => this.log.warn(`Deepgram socket error: ${err.message}`),
      });
    } catch (err) {
      metricInc("bridge_agent_connect_failures_total");
      this.log.error(`could not open Deepgram Voice Agent session: ${(err as Error).message}`);
      this.endCall("agent-unavailable");
      return;
    }

    // The worker may have dropped (ring cancelled, rollout) DURING the connect
    // above. If so, teardown already ran with this.dg still null - assigning the
    // just-opened socket now would orphan a live, billed Voice Agent session
    // that nothing ever closes. Close it and bail.
    if (this.closed) {
      this.log.info("worker closed during Deepgram connect; closing the orphaned agent socket");
      try {
        dg.close();
      } catch {
        /* already closing */
      }
      return;
    }
    this.dg = dg;

    // The one-time Settings message: audio pinned to linear16 @ 16 kHz both
    // ways, agent config, prompt (incl. any context notes that landed during
    // the connect window), greeting, and the functions list (built-ins +
    // embedder-registered custom tools).
    this.dg.sendSettings(
      buildSettings({
        prompt: buildPrompt(this.cfg.instructions, this.callerCtx, this.contextNotes),
        language: this.cfg.language,
        listenModel: this.cfg.listenModel,
        thinkProvider: this.cfg.thinkProvider,
        thinkModel: this.cfg.thinkModel,
        speakModel: this.cfg.speakModel,
        thinkEndpointUrl: this.cfg.thinkEndpointUrl,
        thinkEndpointHeaders: this.cfg.thinkEndpointHeaders,
        greeting: this.cfg.greeting,
        extraFunctions: [...this.customTools.values()].map(customToolSchema),
      }),
    );
    // Audio must wait for the server's SettingsApplied ack (see onDgMessage);
    // bound that wait so a hung Settings application cannot leave the call
    // open and silent until the dead-peer timer.
    this.settingsTimer = setTimeout(() => {
      if (!this.settingsApplied && !this.closed) {
        this.log.error("no SettingsApplied from Deepgram within 10s; ending the call");
        this.endCall("agent-unavailable");
      }
    }, 10_000);
    this.settingsTimer.unref?.();
    this.log.info("Deepgram Voice Agent session open; waiting for SettingsApplied");

    // Bridge-side governor: Deepgram doesn't know about your billing.
    if (this.cfg.maxCallMinutes > 0) {
      const limitMs = this.cfg.maxCallMinutes * 60_000;
      this.governorTimer = setTimeout(() => {
        this.onGovernorLimit().catch((err) => this.log.error(`governor error: ${(err as Error).message}`));
      }, limitMs);
      this.log.info(`governor armed: max ${this.cfg.maxCallMinutes} min`);
    }
  }

  /** Time limit hit: speak the goodbye, let it play out, then tear the call down. */
  private async onGovernorLimit(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.log.info("governor: call time limit reached");
    // If the worker-side governor already started a goodbye, its hard-bounded
    // backstop is armed - do NOT overwrite that timer (the call ends either
    // way, and clobbering it could cut off a goodbye that is still playing).
    if (this.goodbyeInProgress) {
      this.log.info("a goodbye is already in progress; keeping its deadline");
      return;
    }
    // Guarantee teardown regardless of the goodbye. Arm a HARD-bounded
    // deadline BEFORE awaiting performGoodbye - a hung/slow TTS must never
    // wedge the call open past its limit.
    const hardMs = this.cfg.goodbyeGraceMs + GOODBYE_HARD_CAP_MS;
    this.goodbyeTimer = setTimeout(() => this.endCall("time-limit"), hardMs);
    this.goodbyeTimer.unref?.();
    // performGoodbye's TTS fetch is itself time-bounded (see synthesizeGoodbye).
    const playedMs = await this.performGoodbye(this.cfg.goodbyeText);
    if (this.closed) {
      return; // the hard deadline (or another path) already tore down
    }
    // Deterministic TTS reports its real duration; the agent-spoken fallback
    // does not. Reschedule to the real grace, but never later than the hard cap.
    const graceMs = Math.min(playedMs ?? this.cfg.goodbyeGraceMs, hardMs);
    if (this.goodbyeTimer) {
      clearTimeout(this.goodbyeTimer);
    }
    this.goodbyeTimer = setTimeout(() => this.endCall("time-limit"), graceMs + 500);
    this.goodbyeTimer.unref?.();
  }

  /**
   * Group-call speaker attribution: the worker tags audio.frame with the active
   * speaker's display name. Surface it to the agent as a context note so it can
   * reason about who said what. Only in group calls (1:1 attribution is noise),
   * only when the name CHANGES, and rate-limited so VAD flapping between
   * speakers cannot spam the agent.
   */
  private noteSpeaker(name: string | null | undefined): void {
    if (!name || this.participantCount <= 1) {
      return;
    }
    const now = Date.now();
    if (name === this.lastSpeakerName || now - this.lastSpeakerUpdateMs < SPEAKER_UPDATE_MIN_INTERVAL_MS) {
      return;
    }
    this.lastSpeakerName = name;
    this.lastSpeakerUpdateMs = now;
    this.pushContext(`The person now speaking is ${name}.`);
  }

  /**
   * Record a live context note (participants/dtmf/speaker) and push the
   * rebuilt prompt to the agent. The Voice Agent API has no non-interrupting
   * context message, so context rides UpdatePrompt: base instructions + caller
   * context + a bounded rolling notes section. Notes recorded while the socket
   * is still connecting simply land in the initial Settings prompt.
   */
  private pushContext(note: string): void {
    if (this.closed) {
      return;
    }
    this.contextNotes.push(note);
    if (this.contextNotes.length > MAX_CONTEXT_NOTES) {
      this.contextNotes.shift();
    }
    if (this.dg && this.callerCtx) {
      this.dg.updatePrompt(buildPrompt(this.cfg.instructions, this.callerCtx, this.contextNotes));
    }
  }

  // ---- Deepgram -> bridge ----

  /** Agent audio (raw binary linear16 @ 16 kHz): ghost/mute filter, then relay. */
  private onDgAudio(pcm: Buffer): void {
    if (this.muteAgentAudio) {
      this.log.debug("dropping agent audio (deterministic goodbye playing)");
      return;
    }
    if (this.droppingAgentAudio) {
      this.log.debug("dropping ghost agent audio (after barge-in / goodbye flush)");
      return;
    }
    this.emitAudioToWorker(pcm.toString("base64"));
  }

  private onDgMessage(msg: DgInbound): void {
    switch (msg.type) {
      case "UserStartedSpeaking": {
        // Caller barge-in. Deepgram stops generating TTS server-side; mirror
        // the cut to the Teams side and ghost-drop frames still in flight
        // until the agent audibly starts its next utterance.
        this.droppingAgentAudio = true;
        // TurnId is not tracked by this bridge; the worker's flush ignores the value.
        this.sendToWorker({ type: "assistant.cancel", turnId: 0 });
        this.log.info("barge-in: caller speech started");
        break;
      }
      case "AgentStartedSpeaking": {
        // The agent's next utterance begins: stop ghost-dropping (the mute
        // latch, if set by a deterministic goodbye, still wins in onDgAudio).
        this.droppingAgentAudio = false;
        break;
      }
      case "FunctionCallRequest": {
        const calls = (msg as DgFunctionCallRequest).functions;
        if (!Array.isArray(calls)) {
          this.log.warn("FunctionCallRequest without a functions array; dropping");
          return;
        }
        for (const call of calls) {
          // Server-side functions (declared with an endpoint) are executed by
          // Deepgram itself; only client_side calls are ours to answer.
          if (call?.client_side === false) {
            continue;
          }
          if (typeof call?.id !== "string" || typeof call?.name !== "string") {
            this.log.warn("client-side function call missing id/name; dropping");
            continue;
          }
          this.onFunctionCall(call);
        }
        break;
      }
      case "ConversationText": {
        // Recording gate: never log/persist transcripts unless Teams recording is active.
        if (this.cfg.logTranscripts && this.recordingActive) {
          const ev = msg as DgConversationText;
          this.log.info("ConversationText", { role: ev.role, content: ev.content });
        }
        break;
      }
      case "InjectionRefused": {
        // The goodbye fallback can be refused while the agent is mid-utterance;
        // the goodbye grace/backstop still ends the call, so log-only.
        this.log.warn(`InjectionRefused: ${(msg as { message?: string }).message ?? "no detail"}`);
        break;
      }
      case "Error": {
        const ev = msg as DgError;
        this.log.warn(`Deepgram error event: ${ev.code ?? "unknown"}: ${ev.description ?? "no description"}`);
        break;
      }
      case "Warning": {
        this.log.warn(`Deepgram warning: ${(msg as DgWarning).description ?? "no description"}`);
        break;
      }
      case "SettingsApplied": {
        // The server is ready for audio (documented ordering contract). Flush
        // the caller speech buffered since session.start, oldest first.
        this.settingsApplied = true;
        if (this.settingsTimer) {
          clearTimeout(this.settingsTimer);
          this.settingsTimer = null;
        }
        if (this.dg) {
          for (const chunk of this.pendingAudio) {
            this.dg.sendAudioChunk(chunk);
            metricInc("bridge_frames_to_agent_total");
          }
        }
        this.pendingAudio = [];
        this.log.info("SettingsApplied; relaying");
        break;
      }
      case "Welcome":
      case "AgentThinking":
      case "AgentAudioDone":
      case "PromptUpdated":
      case "History":
        this.log.debug(`Deepgram event: ${msg.type}`);
        break;
      default:
        this.log.debug(`ignoring Deepgram event type ${msg.type}`);
    }
  }

  /**
   * Map agent client-side functions -> worker capabilities:
   * end_call -> session.end, express -> expression, show_image -> display.image, look -> vision.
   */
  private onFunctionCall(call: DgFunctionCall): void {
    const id = call.id as string;
    const name = call.name as string;
    let params: Record<string, unknown> = {};
    // Docs say arguments is a JSON-encoded string; tolerate an already-parsed object.
    if (typeof call.arguments === "string" && call.arguments.trim()) {
      try {
        const parsed = JSON.parse(call.arguments) as unknown;
        if (parsed && typeof parsed === "object") {
          params = parsed as Record<string, unknown>;
        }
      } catch {
        this.log.warn(`unparseable arguments for tool ${name}; treating as empty`);
      }
    } else if (call.arguments && typeof call.arguments === "object") {
      params = call.arguments;
    }
    switch (name) {
      case "end_call":
        this.replyTool(id, name, "call ended");
        this.log.info("agent requested end_call");
        this.endCall("agent-ended-call");
        return;
      case "express": {
        const emotion = typeof params.emotion === "string" ? params.emotion.trim() : "";
        if (!emotion) {
          this.replyTool(id, name, "express requires an 'emotion' parameter");
          return;
        }
        if (emotion.length > MAX_EMOTION_CHARS) {
          this.replyTool(id, name, `express: 'emotion' must be at most ${MAX_EMOTION_CHARS} characters`);
          return;
        }
        this.sendToWorker({ type: "expression", emotion });
        this.replyTool(id, name, `expressing ${emotion}`);
        return;
      }
      case "show_image":
        this.onShowImage(id, name, params).catch((err) =>
          this.log.error(`show_image failed: ${(err as Error).message}`),
        );
        return;
      case "look":
        this.onLook(id, name, params).catch((err) =>
          this.log.error(`look failed: ${(err as Error).message}`),
        );
        return;
      default: {
        // Embedder-registered custom tools (the extensibility surface): run the
        // handler, return its string as the function output. A throw becomes an
        // error output so the model can recover; it must never escape into the
        // ws listener.
        const custom = this.customTools.get(name);
        if (custom) {
          Promise.resolve()
            .then(() =>
              custom.handler(params, {
                callId: this.callId,
                participantCount: this.participantCount,
                recordingActive: this.recordingActive,
                log: this.log,
              }),
            )
            .then((output) => this.replyTool(id, name, String(output)))
            .catch((err) => {
              this.log.warn(`custom tool ${name} failed: ${(err as Error).message}`);
              this.replyTool(id, name, `tool "${name}" failed: ${(err as Error).message}`);
            });
          return;
        }
        this.replyTool(id, name, `tool "${name}" is not implemented by this bridge`);
        this.log.warn(`unmapped function tool: ${name}`);
      }
    }
  }

  /** Answer a client-side function call; the agent continues on its own. */
  private replyTool(id: string, name: string, output: string): void {
    this.dg?.sendFunctionCallResponse(id, name, output);
  }

  /**
   * show_image -> display.image on the bot's video tile. Accepts either inline
   * base64 ({dataBase64, mime}) or a URL the bridge fetches server-side.
   */
  private async onShowImage(id: string, name: string, params: Record<string, unknown>): Promise<void> {
    try {
      let dataBase64 = typeof params.dataBase64 === "string" ? params.dataBase64 : null;
      if (dataBase64 && dataBase64.length > MAX_INLINE_IMAGE_B64_CHARS) {
        throw new Error(`inline image too large (${dataBase64.length} base64 chars, max ${MAX_INLINE_IMAGE_B64_CHARS})`);
      }
      let mime = typeof params.mime === "string" ? params.mime : null;
      const url = typeof params.url === "string" ? params.url : null;
      if (!dataBase64 && url) {
        // SSRF guard: the URL is agent-(LLM-)controlled, i.e. indirectly caller-controlled.
        // fetchPublicImage validates the host, then PINS the connect-time DNS
        // resolution through the same private-range check - closing the
        // validate-then-fetch rebind TOCTOU. One re-validated redirect hop,
        // bounded time and size.
        const img = await fetchPublicImage(url, MAX_IMAGE_BYTES, 10_000);
        mime = img.mime;
        dataBase64 = img.bytes.toString("base64");
      }
      if (!dataBase64 || !mime || !/^image\/(jpeg|png)$/.test(mime)) {
        throw new Error("show_image needs {dataBase64, mime} or {url} resolving to image/jpeg or image/png");
      }
      this.sendToWorker({
        type: "display.image",
        dataBase64,
        mime,
        durationMs: typeof params.durationMs === "number" ? params.durationMs : null,
        mode: typeof params.mode === "string" ? params.mode.slice(0, MAX_MODE_CHARS) : null,
        ts: 0,
        caption: typeof params.caption === "string" ? params.caption.slice(0, MAX_CAPTION_CHARS) : null,
      });
      this.replyTool(id, name, "image is being shown to the caller");
    } catch (err) {
      this.log.warn(`show_image failed: ${(err as Error).message}`);
      this.replyTool(id, name, `show_image failed: ${(err as Error).message}`);
    }
  }

  /**
   * Vision on demand - agent function `look`
   * ({source?: "camera"|"screenshare", question?: string}).
   *
   * The Voice Agent API is audio-only (no image input), so there is exactly
   * one route: describe the buffered frame via YOUR vision model (path 2,
   * VISION_API_URL or a custom VisionDescriber) and answer in the function
   * result. The raw frame never leaves the bridge. Without a vision endpoint
   * the tool reports that vision is unavailable.
   */
  private async onLook(id: string, name: string, params: Record<string, unknown>): Promise<void> {
    const requested = typeof params.source === "string" ? params.source : null;
    const frame =
      (requested && this.latestVideoFrame.get(requested)) ??
      this.latestVideoFrame.get("screenshare") ??
      this.latestVideoFrame.get("camera");
    if (!frame) {
      this.replyTool(id, name, "no video is available - the caller has not shared their camera or screen");
      return;
    }
    if (!this.vision) {
      this.replyTool(
        id,
        name,
        "cannot inspect video: no vision endpoint is configured on this bridge (set VISION_API_URL)",
      );
      return;
    }
    // Optional compliance gate: camera/screen frames are PII-bearing, so
    // deployments can require Teams recording to be active before any frame
    // is sent to the vision endpoint.
    if (this.cfg.visionRequiresRecording && !this.recordingActive) {
      this.replyTool(
        id,
        name,
        "cannot inspect video: Teams recording is not active and this bridge requires recording before frames may be processed",
      );
      return;
    }
    const question =
      typeof params.question === "string" && params.question.trim()
        ? params.question.trim()
        : "Describe what is visible.";
    try {
      // Path 2 is INTENTIONALLY NOT recording-gated (parity with the sibling
      // bridges): the raw frame never leaves the bridge - only a text
      // description does - but that description becomes Voice Agent
      // conversation content, retained per your Deepgram data settings.
      const description = await this.vision(frame, question);
      this.replyTool(id, name, description);
    } catch (err) {
      this.log.warn(`look failed: ${(err as Error).message}`);
      this.replyTool(id, name, `look failed: ${(err as Error).message}`);
    }
  }

  // ---- governor goodbye ----

  /**
   * Speak a goodbye line (both governors: worker assistant.say and the
   * bridge-side time limit). Flushes buffered playback first (assistant.cancel
   * to the worker + ghost-drop in-flight agent frames) so stale agent audio
   * cannot delay the goodbye.
   *
   * Preferred: deterministic, the exact text via standalone Aura TTS
   * (DEEPGRAM_TTS_MODEL) - the agent is hard-muted while it plays and the real
   * duration (ms) is returned. Fallback: the live agent speaks the exact text
   * via InjectAgentMessage - its audio MUST keep relaying (mute stays off),
   * duration unknown (null).
   */
  private async performGoodbye(text: string): Promise<number | null> {
    // Both governors can race (worker assistant.say + bridge time limit). Running
    // performGoodbye twice would double-speak and leave the mute latch in an
    // ambiguous state - first one wins.
    if (this.goodbyeInProgress) {
      this.log.info("goodbye already in progress; ignoring duplicate");
      return null;
    }
    this.goodbyeInProgress = true;
    this.log.info("speaking goodbye");
    // Backstop teardown for the WORKER-side governor path (assistant.say): the
    // worker is expected to tear the call down after the goodbye, but if it is
    // buggy/slow the call must not sit open (agent muted) until the dead-peer
    // timer. The bridge-side governor arms its own tighter deadline first, in
    // which case this is skipped.
    if (!this.goodbyeTimer) {
      this.goodbyeTimer = setTimeout(() => this.endCall("goodbye-timeout"), this.cfg.goodbyeGraceMs + GOODBYE_HARD_CAP_MS);
      this.goodbyeTimer.unref?.();
    }
    this.sendToWorker({ type: "assistant.cancel", turnId: 0 });
    // Flush in-flight agent frames; AgentStartedSpeaking (the injected goodbye,
    // or nothing) clears this.
    this.droppingAgentAudio = true;
    if (this.cfg.ttsModel) {
      try {
        this.muteAgentAudio = true; // only the deterministic goodbye may speak now
        const pcm = await synthesizeGoodbye(this.cfg, text); // returns 16 kHz wire PCM
        // Emit as 20 ms frames like the hot path, rather than one multi-second
        // frame, so playback does not depend on the worker re-aligning a giant
        // chunk (parity with normal relay). emitAudioToWorker is used directly:
        // the mute latch only filters AGENT audio (onDgAudio), not the goodbye.
        // The goodbye is the LAST thing the caller hears - a load-bearing
        // utterance, not disposable realtime audio. Never drop it under
        // worker backpressure (undroppable), unlike the normal hot path.
        for (let off = 0; off < pcm.length; off += PCM16K_FRAME_BYTES) {
          this.emitAudioToWorker(pcm.subarray(off, off + PCM16K_FRAME_BYTES).toString("base64"), true);
        }
        return pcm16kBytesToMs(pcm.length);
      } catch (err) {
        this.muteAgentAudio = false; // fallback: the agent must stay audible
        this.log.warn(`goodbye TTS failed (${(err as Error).message}); falling back to InjectAgentMessage`);
      }
    }
    // The live agent speaks the exact text in its own voice. May be refused
    // (InjectionRefused) if the agent is mid-utterance; the goodbye backstop
    // still ends the call.
    this.dg?.injectAgentMessage(text);
    return null;
  }

  // ---- plumbing ----

  private emitAudioToWorker(base64Pcm: string, undroppable = false): void {
    const frame: AudioFrameMessage = {
      type: "audio.frame",
      seq: this.outSeq++,
      timestampMs: Math.round(this.outTimestampMs),
      payloadBase64: base64Pcm,
    };
    // advance the timeline by the actual PCM duration (base64 -> bytes -> ms)
    this.outTimestampMs += pcm16kBytesToMs(Buffer.byteLength(base64Pcm, "base64"));
    metricInc("bridge_frames_to_worker_total");
    this.sendToWorker(frame, undroppable);
  }

  private sendToWorker(msg: WorkerOutbound, undroppable = false): void {
    if (this.worker.readyState !== this.worker.OPEN) {
      return;
    }
    // Backpressure guard: ws.send is fire-and-forget, so if the worker stalls,
    // bufferedAmount grows unbounded (50 audio.frames/s) and leaks memory.
    // Above the cap, drop this frame rather than queue it - audio is realtime,
    // a stale frame is worthless, and this bounds memory (parity with siblings).
    // ONLY the continuous realtime type (audio.frame, ~50/s) is droppable.
    // Control frames (assistant.cancel, session.end, pong, expression) are tiny
    // and semantically load-bearing, and display.image is a ONE-SHOT the agent
    // has already been told succeeded - silently dropping it would desync the
    // agent's belief from what the caller sees. A stalled-then-recovered worker
    // must not miss a barge-in cancel, a hangup, or a promised image.
    // (Goodbye TTS frames are audio.frame on the wire but semantically a
    // control utterance - performGoodbye marks them undroppable.)
    const droppable = msg.type === "audio.frame" && !undroppable;
    if (droppable && this.worker.bufferedAmount > MAX_OUTBOUND_BUFFER_BYTES) {
      // Throttle the log: at ~50 frames/s a stalled worker would emit 50 warn
      // lines/s. Count drops and warn at most once per second with the total.
      this.droppedFrames++;
      metricInc("bridge_frames_dropped_total");
      const now = Date.now();
      if (now - this.lastBackpressureWarnMs >= 1000) {
        this.log.warn(
          `worker send backpressure: dropped ${this.droppedFrames} frame(s) (buffered ${this.worker.bufferedAmount} bytes)`,
        );
        this.lastBackpressureWarnMs = now;
        this.droppedFrames = 0;
      }
      return;
    }
    this.worker.send(JSON.stringify(msg));
  }

  /** Graceful external shutdown (e.g. SIGTERM drain): tell the worker the call
   *  is ending, then close both sockets. Idempotent via teardown's closed flag. */
  shutdown(reason: string): void {
    this.endCall(reason);
  }

  /** Ask the worker to tear the call down, then close both sockets. */
  private endCall(reason: string): void {
    if (!this.closed) {
      this.sendToWorker({ type: "session.end", reason });
    }
    this.teardown(reason);
  }

  private teardown(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.log.info(`teardown: ${reason}`);
    // call duration: cumulative counter (averages) + histogram (p50/p95/p99)
    const durationS = (Date.now() - this.startMs) / 1000;
    metricInc("bridge_call_seconds_total", durationS);
    metricObserve("bridge_call_duration_seconds", durationS);
    // symmetry: the mute latch must never outlive the goodbye that set it
    this.muteAgentAudio = false;
    if (this.governorTimer) {
      clearTimeout(this.governorTimer);
      this.governorTimer = null;
    }
    if (this.goodbyeTimer) {
      clearTimeout(this.goodbyeTimer);
      this.goodbyeTimer = null;
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.settingsTimer) {
      clearTimeout(this.settingsTimer);
      this.settingsTimer = null;
    }
    try {
      this.dg?.close();
    } catch {
      /* already closing */
    }
    try {
      this.worker.close(1000, reason);
    } catch {
      /* already closing */
    }
    this.latestVideoFrame.clear();
    this.pendingAudio = [];
    this.contextNotes = [];
    // let the server de-register this call (registry eviction, dup-callId dedup)
    try {
      this.onClosed?.();
    } catch {
      /* registry callback must never throw back into teardown */
    }
  }
}
