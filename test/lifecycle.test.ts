import { test, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.js";
import { sign } from "../src/hmac.js";
import { loadConfig } from "../src/config.js";
import type { BridgeConfig } from "../src/config.js";
import type { AgentPort, DgInbound, DgSessionHandlers } from "../src/deepgram.js";

const baseCfg: BridgeConfig = {
  port: 0,
  host: "127.0.0.1",
  workerSharedSecret: "test-secret",
  deepgramApiKey: "unused",
  agentHost: "agent.deepgram.com",
  apiHost: "api.deepgram.com",
  listenModel: "nova-3",
  thinkProvider: "open_ai",
  thinkModel: "gpt-4o-mini",
  speakModel: "aura-2-thalia-en",
  language: "en",
  instructions: null,
  greeting: null,
  ttsModel: null,
  maxCallMinutes: 0,
  goodbyeText: "Goodbye!",
  goodbyeGraceMs: 8000,
  visionApiUrl: null,
  visionApiKey: null,
  visionModel: null,
  hmacFreshnessMs: 60_000,
  maxConnections: 0,
  maxConnectionsPerIp: 0,
  preStartTimeoutMs: 0,
  workerIdleTimeoutMs: 0,
  trustProxy: false,
  tlsCertPath: null,
  tlsKeyPath: null,
  logTranscripts: false,
};

/** Minimal fake agent; one fresh instance per test so state never bleeds across cases. */
class FakeAgent implements AgentPort {
  isOpen = true;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  handlers!: DgSessionHandlers;
  sendAudioChunk(b64: string): void { this.sent.push({ type: "binary_audio", audio: b64 }); }
  sendSettings(settings: Record<string, unknown>): void { this.sent.push(settings); }
  updatePrompt(prompt: string): void { this.sent.push({ type: "UpdatePrompt", prompt }); }
  injectAgentMessage(text: string): void { this.sent.push({ type: "InjectAgentMessage", message: text }); }
  sendFunctionCallResponse(id: string, name: string, content: string): void {
    this.sent.push({ type: "FunctionCallResponse", id, name, content });
  }
  close(): void { this.closed = true; }
  emit(msg: DgInbound): void { this.handlers.onMessage(msg); }
  emitAudio(pcm: Buffer): void { this.handlers.onAudio(pcm); }
}

function until<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error("until() timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function upgradeHeaders(callId: string, secret = baseCfg.workerSharedSecret): Record<string, string> {
  const ts = Date.now();
  return {
    "X-StandIn-Timestamp": String(ts),
    "X-StandIn-Signature": sign(secret, ts, callId),
  };
}

// ---- worker dies while the Deepgram socket is still connecting ----
test("worker closing during Deepgram connect closes the orphaned agent socket", async () => {
  const fake = new FakeAgent();
  let releaseConnect: () => void = () => {};
  const gate = new Promise<void>((r) => (releaseConnect = r));
  const connectDg = async (_c: BridgeConfig, _l: unknown, handlers: DgSessionHandlers): Promise<AgentPort> => {
    fake.handlers = handlers;
    await gate; // hold the connect open until the worker has closed
    return fake;
  };
  const server = startServer({ ...baseCfg }, connectDg, null);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  after(() => server.close());

  const callId = "c1-orphan";
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, { headers: upgradeHeaders(callId) });
  await new Promise<void>((r) => ws.once("open", () => r()));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  // give onSessionStart a tick to enter the awaited connect, then kill the worker
  await new Promise((r) => setTimeout(r, 30));
  ws.close();
  await new Promise((r) => setTimeout(r, 30));
  releaseConnect(); // connect now resolves AFTER teardown already ran
  // the just-opened agent socket must be closed, not left as an orphaned billed session
  await until(() => (fake.closed ? true : undefined));
  assert.equal(fake.closed, true);
  assert.equal(fake.sent.length, 0, "must not send Settings on a torn-down call");
});

// ---- duplicate callId rejection ----
test("rejects a second live connection for the same callId (409)", async () => {
  const fake = new FakeAgent();
  const connectDg = async (_c: BridgeConfig, _l: unknown, handlers: DgSessionHandlers): Promise<AgentPort> => {
    fake.handlers = handlers;
    return fake;
  };
  const server = startServer({ ...baseCfg }, connectDg, null);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  after(() => server.close());

  const callId = "dup-1";
  const a = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, { headers: upgradeHeaders(callId) });
  await new Promise<void>((r) => a.once("open", () => r()));
  a.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await until(() => fake.sent.find((m) => m.type === "Settings"));

  // second connection for the SAME callId (fresh, valid handshake) must be rejected
  const b = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, { headers: upgradeHeaders(callId) });
  const err = await new Promise<Error>((resolve) => b.once("error", resolve));
  assert.match(err.message, /409|Unexpected server response: 409/);
  a.close();
});

// ---- numeric env validation fails loud ----
test("loadConfig throws on a non-numeric MAX_CALL_MINUTES", () => {
  const saved = { ...process.env };
  try {
    process.env.WORKER_SHARED_SECRET = "s";
    process.env.DEEPGRAM_API_KEY = "k";
    process.env.MAX_CALL_MINUTES = "abc";
    assert.throws(() => loadConfig(), /MAX_CALL_MINUTES.*not a number/);
  } finally {
    process.env = saved;
  }
});

test("dead-peer: a silent worker socket is torn down after the idle window and the callId is freed", async () => {
  const fake = new FakeAgent();
  const connectDg = async (_c: BridgeConfig, _l: unknown, handlers: DgSessionHandlers): Promise<AgentPort> => {
    fake.handlers = handlers;
    return fake;
  };
  // 150ms idle window (check interval = max(20, 150/3) = 50ms)
  const server = startServer({ ...baseCfg, workerIdleTimeoutMs: 150 }, connectDg, null);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;

  const callId = "call-idle-1";
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, { headers: upgradeHeaders(callId) });
  await new Promise<void>((r) => ws.once("open", () => r()));
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await until(() => fake.sent.find((m) => m.type === "Settings"));

  // keep-alive traffic holds the session open past the window...
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 60));
    ws.send(JSON.stringify({ type: "ping", ts: i }));
  }
  assert.equal(ws.readyState, WebSocket.OPEN, "active session must survive the idle window");

  // ...then true silence tears it down and frees the callId (no 409 lockout)
  const end = await until(() => received.find((m) => m.type === "session.end"), 2000);
  assert.equal(end.reason, "worker-idle-timeout");
  await until(() => (fake.closed ? true : undefined));
  await until(() => (ws.readyState === WebSocket.CLOSED ? true : undefined));

  const headers2 = upgradeHeaders(callId);
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, { headers: headers2 });
  await new Promise<void>((resolve, reject) => {
    ws2.once("open", () => resolve());
    ws2.once("error", (e) => reject(new Error(`reconnect after idle teardown must not 409: ${e.message}`)));
  });
  ws2.close();
  server.close();
});

test("pre-start bypass closed: pings without session.start no longer defuse the timer", async () => {
  const connectDg = async () => {
    throw new Error("Deepgram must never be dialed for a never-started session");
  };
  const server = startServer({ ...baseCfg, preStartTimeoutMs: 200 }, connectDg as never, null);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;

  const callId = "call-nostart-1";
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, { headers: upgradeHeaders(callId) });
  await new Promise<void>((r) => ws.once("open", () => r()));
  // keep sending pings - under a naive implementation the FIRST message defuses the timer
  const pinger = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", ts: 1 }));
  }, 40);
  const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
  clearInterval(pinger);
  assert.equal(code, 1008, "authenticated-but-never-started socket must be closed at the pre-start deadline");
  server.close();
});

test("startServer does not register SIGTERM/SIGINT handlers unless opted in (library must not exit the host)", async () => {
  const beforeTerm = process.listenerCount("SIGTERM");
  const beforeInt = process.listenerCount("SIGINT");
  const server = startServer({ ...baseCfg }, undefined, null); // no handleSignals
  await new Promise<void>((r) => server.once("listening", () => r()));
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm, "no SIGTERM handler without opt-in");
  assert.equal(process.listenerCount("SIGINT"), beforeInt, "no SIGINT handler without opt-in");
  server.close();
});
