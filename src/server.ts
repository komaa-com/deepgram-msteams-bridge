import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { BridgeConfig } from "./config.js";
import { isFresh, verify, LEGACY_SIGNATURE_HEADER, LEGACY_TIMESTAMP_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./hmac.js";
import { logger } from "./log.js";
import { CallSession, type DgConnector } from "./session.js";
import { BRIDGE_FUNCTIONS, type CustomTool } from "./deepgram.js";
import { makeVisionDescriber, type VisionDescriber } from "./vision.js";
import { metricDec, metricInc, renderMetrics } from "./metrics.js";

const log = logger("server");

/**
 * Worker-facing WebSocket server. The StandIn media bridge dials
 * {wsBaseUrl}/{callId} with an HMAC-signed upgrade
 * (X-StandIn-Timestamp / -Signature over "{timestampMs}.{callId}");
 * the bridge validates exactly like the sibling bridges do.
 */

// DoS guards - parity with the sibling bridges. A single shared secret gates
// the upgrade, but a buggy or compromised worker (or a leaked secret) must not
// be able to exhaust memory/sockets.
/** Max inbound WS frame. Caller audio is ~640 B/frame; a JPEG video.frame is the
 *  large one. 2 MB matches the siblings and bounds a single message. */
const MAX_INBOUND_PAYLOAD_BYTES = 2 * 1024 * 1024;

/** WS-level ping interval; a client that misses a pong is terminated next tick. */
const WORKER_HEARTBEAT_MS = 30_000;
/** Max concurrent worker connections (one per live call). */
const DEFAULT_MAX_CONNECTIONS = 64;
/** A worker that authenticates but never sends session.start is dropped after this. */
const DEFAULT_PRE_START_TIMEOUT_MS = 10_000;
/** Bounded window for queued session.end frames + close handshakes to flush on shutdown. */
const SHUTDOWN_GRACE_MS = 2_000;

/** callId = last non-empty path segment of the upgrade URL. */
export function callIdFromUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  const path = url.split("?")[0];
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }
  try {
    // A malformed percent-escape (e.g. `%zz`) makes decodeURIComponent throw
    // URIError. This runs inside the "upgrade" listener BEFORE auth, so an
    // unguarded throw would be an uncaught exception that kills the process and
    // drops every live call - a pre-auth remote crash. Treat it as no callId.
    return decodeURIComponent(segments[segments.length - 1]);
  } catch {
    return null;
  }
}

/**
 * Single-use guard for verified upgrade tuples (callId, ts, sig). Even inside
 * the freshness window, a captured handshake must not be replayable to open a
 * second (ghost) session for the same call. Records survive until the timestamp
 * itself stops being fresh (ts + window), matching the sibling bridges.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(private readonly windowMs: number) {}

  /** Returns true if this tuple is NEW (and records it); false if already used. */
  claim(callId: string, ts: number, sig: string, nowMs = Date.now()): boolean {
    for (const [key, expiry] of this.seen) {
      if (expiry <= nowMs) {
        this.seen.delete(key);
      }
    }
    const key = `${callId}.${ts}.${sig}`;
    if (this.seen.has(key)) {
      return false;
    }
    // Expire when the timestamp stops being fresh, not "now + window": the tuple
    // is unusable past ts + windowMs anyway (isFresh would reject it).
    this.seen.set(key, ts + this.windowMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export function authorizeUpgrade(
  cfg: BridgeConfig,
  req: IncomingMessage,
  replay?: ReplayGuard,
): { callId: string } | { error: string } {
  const callId = callIdFromUrl(req.url);
  if (!callId) {
    return { error: "no callId in path" };
  }
  // Fail closed: an empty/unset shared secret must reject every upgrade rather
  // than authenticating anyone. loadConfig() requires it, but never trust that.
  if (!cfg.workerSharedSecret) {
    return { error: "bridge shared secret is not configured" };
  }
  const tsHeader = req.headers[TIMESTAMP_HEADER] ?? req.headers[LEGACY_TIMESTAMP_HEADER];
  const sigHeader = req.headers[SIGNATURE_HEADER] ?? req.headers[LEGACY_SIGNATURE_HEADER];
  const ts = Number(Array.isArray(tsHeader) ? tsHeader[0] : tsHeader);
  const sig = (Array.isArray(sigHeader) ? sigHeader[0] : sigHeader) ?? "";
  if (!isFresh(ts, cfg.hmacFreshnessMs)) {
    return { error: "stale or missing timestamp" };
  }
  if (!verify(cfg.workerSharedSecret, ts, callId, sig)) {
    return { error: "bad signature" };
  }
  // Replay guard runs LAST, so an unauthenticated probe can never consume a
  // replay slot (it fails the signature check first).
  if (replay && !replay.claim(callId, ts, sig)) {
    return { error: "replayed handshake" };
  }
  return { callId };
}

/**
 * Best-effort remote-IP key for the per-IP connection cap. StandIn is a hosted
 * service dialing from a small set of egress IPs, and a reverse proxy/LB collapses
 * every client to its own address - so keying on socket.remoteAddress alone makes
 * the per-IP cap either useless (all one IP) or a footgun (throttles all calls).
 * When `trustProxy` is set, use the FIRST X-Forwarded-For hop instead. Only enable
 * it behind a proxy you control (the header is client-spoofable otherwise).
 */
function remoteKey(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Options for startServer beyond the env-driven config. */
export interface StartServerOptions {
  /**
   * Wire SIGTERM/SIGINT to a graceful drain THAT EXITS THE PROCESS. Default
   * false: a library must never call process.exit on its host - only the CLI
   * (which owns the process) enables this. Embedders handle their own signals
   * and call the sessions' shutdown via closing the server.
   */
  handleSignals?: boolean;
  /**
   * Custom client-side function tools the BRIDGE executes: registered in every
   * session's Settings; when the agent calls one, the handler runs in-process
   * and its string return goes back as the FunctionCallResponse content.
   * Names must not collide with the built-in bridge functions.
   */
  tools?: CustomTool[];
}

// SIGTERM/SIGINT drain: on shutdown, gracefully end every live call (notify the
// worker with session.end + close both sockets) instead of hard-dropping calls
// on a redeploy. OPT-IN (CLI only): exits the process when done. Wired exactly
// once per process (process.once) so repeated startServer calls (tests) never
// accumulate listeners.
const liveRegistries = new Set<Map<string, CallSession>>();
let signalsWired = false;
let draining = false;
function wireDrainSignals(): void {
  if (signalsWired) {
    return;
  }
  signalsWired = true;
  const drain = (sig: string): void => {
    // A second signal during the drain grace means the operator wants OUT NOW
    // (a process.once handler would silently ignore it and keep waiting).
    if (draining) {
      log.warn(`${sig} received again during drain; exiting immediately`);
      process.exit(1);
    }
    draining = true;
    const sessions = [...liveRegistries].flatMap((m) => [...m.values()]);
    log.info(`${sig}: draining ${sessions.length} live call(s)`);
    for (const s of sessions) {
      try {
        s.shutdown("bridge-shutdown");
      } catch {
        /* keep draining the rest */
      }
    }
    // shutdown() queues session.end + starts the close handshakes asynchronously;
    // exiting immediately would cut those before they flush. Give a bounded window
    // (only if there were live calls), then exit no matter what.
    setTimeout(() => process.exit(0), sessions.length > 0 ? SHUTDOWN_GRACE_MS : 0);
  };
  process.on("SIGTERM", () => drain("SIGTERM"));
  process.on("SIGINT", () => drain("SIGINT"));
}

export function startServer(
  cfg: BridgeConfig,
  connectDg?: DgConnector,
  vision?: VisionDescriber | null,
  options?: StartServerOptions,
): ReturnType<typeof createServer> {
  // Custom tool names must not shadow the built-in bridge functions - fail loud
  // at startup rather than dispatching ambiguously mid-call.
  const builtinNames = new Set(BRIDGE_FUNCTIONS.map((t) => String(t.name)));
  const customTools = options?.tools ?? [];
  for (const t of customTools) {
    if (builtinNames.has(t.name)) {
      throw new Error(`custom tool "${t.name}" collides with a built-in bridge tool`);
    }
  }
  const seen = new Set<string>();
  for (const t of customTools) {
    if (seen.has(t.name)) {
      throw new Error(`custom tool "${t.name}" is registered twice`);
    }
    seen.add(t.name);
  }
  const maxConnections = cfg.maxConnections > 0 ? cfg.maxConnections : DEFAULT_MAX_CONNECTIONS;
  // Per-IP cap defaults to the TOTAL cap (i.e. effectively off) rather than a low
  // fixed number: the bridge's only legitimate client is StandIn, which dials from
  // a small set of IPs, so a low per-IP cap would silently throttle total concurrent
  // calls. Set MAX_CONNECTIONS_PER_IP explicitly (with TRUST_PROXY_XFF when behind
  // a proxy) if you want a real per-IP limit.
  const maxPerIp = cfg.maxConnectionsPerIp > 0 ? cfg.maxConnectionsPerIp : maxConnections;
  const preStartTimeoutMs = cfg.preStartTimeoutMs > 0 ? cfg.preStartTimeoutMs : DEFAULT_PRE_START_TIMEOUT_MS;
  const replay = new ReplayGuard(cfg.hmacFreshnessMs);

  let openConnections = 0;
  const perIp = new Map<string, number>();
  // Live calls keyed by callId: rejects a duplicate callId (a fresh handshake
  // for an already-live call would otherwise open a SECOND billed Realtime
  // session for the same call) and backs the SIGTERM drain.
  const sessions = new Map<string, CallSession>();
  liveRegistries.add(sessions);
  if (options?.handleSignals) {
    wireDrainSignals();
  }

  const onRequest = (req: IncomingMessage, res: import("node:http").ServerResponse): void => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(renderMetrics());
      return;
    }
    res.writeHead(404);
    res.end();
  };

  // Native TLS (wss) when both cert + key are provided; otherwise plain WS, which
  // MUST be fronted by a TLS terminator (tunnel / ingress / LB) - caller audio and
  // video would otherwise cross the wire in plaintext.
  let httpServer: Server;
  if (cfg.tlsCertPath && cfg.tlsKeyPath) {
    httpServer = createHttpsServer(
      { cert: readFileSync(cfg.tlsCertPath), key: readFileSync(cfg.tlsKeyPath) },
      onRequest,
    ) as unknown as Server;
    log.info("native TLS enabled (wss)");
  } else {
    httpServer = createServer(onRequest);
    log.warn("no TLS_CERT_PATH/TLS_KEY_PATH: serving plain WS - front this with a TLS terminator in production");
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_PAYLOAD_BYTES });

  // WS-level heartbeat: a half-open worker socket (NAT drop, peer crash) delivers
  // neither a close nor data. Ping every 30 s and terminate a client that missed
  // the previous pong, so a dead socket is reclaimed in ~1 interval instead of
  // waiting out the session idle timer (during which the callId 409-blocks
  // reconnects). Parity with the Python siblings' aiohttp heartbeat=30.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const c = client as WebSocket & { isAlive?: boolean };
      if (c.isAlive === false) {
        c.terminate();
        continue;
      }
      c.isAlive = false;
      try {
        c.ping();
      } catch {
        /* socket already closing */
      }
    }
  }, WORKER_HEARTBEAT_MS);
  heartbeat.unref?.();

  const reject = (socket: Duplex, status: string, reason: string, ip: string): void => {
    log.warn(`rejected upgrade from ${ip}: ${reason}`);
    // The peer may already be gone; only write while the socket is alive.
    if (!socket.destroyed) {
      socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
    }
    socket.destroy();
  };

  httpServer.on("upgrade", (req, socket, head) => {
    // A peer can drop the connection at any moment in the window before the
    // WebSocket exists; give the raw socket an error handler so that stays tidy
    // (the reject write below also skips sockets that are already gone).
    socket.on("error", () => {
      socket.destroy();
    });
    const ip = remoteKey(req, cfg.trustProxy);
    // Defense in depth: any throw in this listener is an uncaught exception that
    // kills the process (callIdFromUrl is guarded, but never rely on one guard).
    try {
      processUpgrade(req, socket, head, ip);
    } catch (err) {
      log.error(`upgrade handler threw: ${(err as Error).message}`);
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
  });

  function processUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ip: string): void {
    // Cheap caps first (before HMAC) so a flood can't force expensive crypto.
    if (openConnections >= maxConnections) {
      metricInc("bridge_upgrades_rejected_cap_total");
      return reject(socket, "503 Service Unavailable", "server connection cap reached", ip);
    }
    if ((perIp.get(ip) ?? 0) >= maxPerIp) {
      metricInc("bridge_upgrades_rejected_cap_total");
      return reject(socket, "503 Service Unavailable", "per-IP connection cap reached", ip);
    }
    const auth = authorizeUpgrade(cfg, req, replay);
    if ("error" in auth) {
      metricInc("bridge_upgrades_rejected_auth_total");
      return reject(socket, "401 Unauthorized", auth.error, ip);
    }
    // A live session already owns this callId - a retry/rollout reconnect. Reject
    // rather than spin up a second billed agent session for one call.
    if (sessions.has(auth.callId)) {
      metricInc("bridge_upgrades_rejected_duplicate_total");
      return reject(socket, "409 Conflict", `callId ${auth.callId.slice(0, 12)}... already has a live session`, ip);
    }
    // Claim the connection slots BEFORE the async handleUpgrade callback runs -
    // a burst of simultaneous upgrades could otherwise all pass the cap checks
    // above and transiently exceed the caps. Released exactly once, whether the
    // ws is adopted (its close event) or the raw socket dies un-adopted.
    openConnections++;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    let released = false;
    const releaseSlots = (): void => {
      if (released) {
        return;
      }
      released = true;
      openConnections = Math.max(0, openConnections - 1);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) {
        perIp.delete(ip);
      } else {
        perIp.set(ip, n);
      }
    };
    socket.once("close", releaseSlots); // covers the never-adopted path

    wss.handleUpgrade(req, socket, head, (ws) => {
      const alive = ws as WebSocket & { isAlive?: boolean };
      alive.isAlive = true;
      ws.on("pong", () => {
        alive.isAlive = true;
      });
      log.info(`worker connected for call ${auth.callId.slice(0, 12)}... (${openConnections}/${maxConnections})`);
      metricInc("bridge_calls_total");
      metricInc("bridge_calls_active");

      const session = new CallSession(
        cfg,
        ws,
        auth.callId,
        connectDg,
        vision === undefined ? makeVisionDescriber(cfg) : vision,
        () => sessions.delete(auth.callId), // evict on teardown (dedup + drain registry)
        customTools,
      );
      sessions.set(auth.callId, session);

      // Drop a worker that authenticates but never STARTS a call. The timer asks
      // the session whether session.start actually arrived - clearing on the
      // first message of any type would let an authenticated client hold the
      // socket forever by sending pings.
      const preStartTimer = setTimeout(() => {
        if (!session.hasStarted) {
          log.warn(`call ${auth.callId.slice(0, 12)}... sent no session.start in ${preStartTimeoutMs}ms; closing`);
          try {
            ws.close(1008, "no session.start");
          } catch {
            /* already closing */
          }
        }
      }, preStartTimeoutMs);
      preStartTimer.unref?.();

      ws.once("close", () => {
        clearTimeout(preStartTimer);
        metricDec("bridge_calls_active");
        releaseSlots();
      });
    });
  }

  httpServer.on("close", () => {
    clearInterval(heartbeat);
    liveRegistries.delete(sessions);
  });

  httpServer.listen(cfg.port, cfg.host, () => {
    log.info(
      `deepgram-msteams-bridge listening on ${cfg.host}:${cfg.port} ` +
        `(listen ${cfg.listenModel}, think ${cfg.thinkProvider}/${cfg.thinkModel}, speak ${cfg.speakModel})`,
    );
  });
  return httpServer;
}
