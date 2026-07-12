import { test, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.js";
import { sign } from "../src/hmac.js";
import type { BridgeConfig } from "../src/config.js";
import type { AgentPort, DgInbound, DgSessionHandlers } from "../src/deepgram.js";

const cfg: BridgeConfig = {
  port: 0,
  host: "127.0.0.1",
  workerSharedSecret: "test-secret",
  deepgramApiKey: "unused-in-tests",
  agentHost: "agent.deepgram.com",
  apiHost: "api.deepgram.com",
  listenModel: "nova-3",
  thinkProvider: "open_ai",
  thinkModel: "gpt-4o-mini",
  speakModel: "aura-2-thalia-en",
  language: "en",
  instructions: null,
  greeting: null,
  ttsModel: null, // goodbye falls back to InjectAgentMessage
  maxCallMinutes: 0,
  goodbyeText: "Time limit reached, goodbye!",
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

/** Fake Deepgram Voice Agent: records what the bridge sends, lets tests push events/audio back. */
class FakeAgent implements AgentPort {
  isOpen = true;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  handlers!: DgSessionHandlers;

  sendAudioChunk(b64: string): void {
    this.sent.push({ type: "binary_audio", audio: b64 });
  }
  sendSettings(settings: Record<string, unknown>): void {
    this.sent.push(settings);
  }
  updatePrompt(prompt: string): void {
    this.sent.push({ type: "UpdatePrompt", prompt });
  }
  injectAgentMessage(text: string): void {
    this.sent.push({ type: "InjectAgentMessage", message: text });
  }
  sendFunctionCallResponse(id: string, name: string, content: string): void {
    this.sent.push({ type: "FunctionCallResponse", id, name, content });
  }
  close(): void {
    this.closed = true;
  }
  emit(msg: DgInbound): void {
    this.handlers.onMessage(msg);
  }
  emitAudio(pcm: Buffer): void {
    this.handlers.onAudio(pcm);
  }
}

const fakeAgent = new FakeAgent();
const connectDg = async (_cfg: BridgeConfig, _log: unknown, handlers: DgSessionHandlers): Promise<AgentPort> => {
  fakeAgent.handlers = handlers;
  return fakeAgent;
};

// server A: no vision endpoint (look reports vision unavailable)
const server = startServer(cfg, connectDg, null);
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
after(() => server.close());

// server B: vision path 2 via a fake describer
const fakeAgentB = new FakeAgent();
const connectDgB = async (_cfg: BridgeConfig, _log: unknown, handlers: DgSessionHandlers): Promise<AgentPort> => {
  fakeAgentB.handlers = handlers;
  return fakeAgentB;
};
const serverB = startServer({ ...cfg }, connectDgB, async (frame, question) => `I see a ${frame.source} frame. Q was: ${question}`);
await new Promise<void>((r) => serverB.once("listening", () => r()));
const portB = (serverB.address() as AddressInfo).port;
after(() => serverB.close());

const CALL_ID = "call-e2e-1";

function workerUrl(callId: string, opts?: { badSig?: boolean; staleTs?: boolean }): { url: string; headers: Record<string, string> } {
  const ts = opts?.staleTs ? Date.now() - 3_600_000 : Date.now();
  const sig = opts?.badSig ? "0".repeat(64) : sign(cfg.workerSharedSecret, ts, callId);
  return {
    url: `ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`,
    headers: { "X-StandIn-Timestamp": String(ts), "X-StandIn-Signature": sig },
  };
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (d) => resolve(JSON.parse(d.toString())));
    ws.once("error", reject);
    ws.once("close", () => reject(new Error("socket closed while waiting for message")));
  });
}

function until<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error("until() timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("rejects a bad signature with 401", async () => {
  const { url, headers } = workerUrl("call-unauth", { badSig: true });
  const ws = new WebSocket(url, { headers });
  const err = await new Promise<Error>((r) => ws.once("error", r));
  assert.match(err.message, /401/);
});

test("rejects a stale timestamp", async () => {
  const { url, headers } = workerUrl("call-stale", { staleTs: true });
  const ws = new WebSocket(url, { headers });
  const err = await new Promise<Error>((r) => ws.once("error", r));
  assert.match(err.message, /401/);
});

test("full relay: settings, audio both ways, barge-in ghosts, ping/pong, context, tools, goodbye", async () => {
  const { url, headers } = workerUrl(CALL_ID);
  const ws = new WebSocket(url, { headers });
  await new Promise<void>((r) => ws.once("open", () => r()));

  // session.start -> bridge opens (fake) Deepgram and sends Settings with defaulted nullables
  ws.send(JSON.stringify({
    type: "session.start",
    callId: CALL_ID,
    threadId: "19:thread",
    caller: { aadId: null, displayName: "Alaa", tenantId: null },
    direction: "inbound",
  }));
  const settings = await until(() => fakeAgent.sent.find((m) => m.type === "Settings"));
  const audio = settings.audio as { input: { encoding: string; sample_rate: number }; output: { sample_rate: number; container: string } };
  assert.equal(audio.input.encoding, "linear16");
  assert.equal(audio.input.sample_rate, 16_000, "the wire rate - copy-only relay");
  assert.equal(audio.output.sample_rate, 16_000);
  assert.equal(audio.output.container, "none");
  const agent = settings.agent as { think: { prompt: string; functions: Array<{ name: string }> }; greeting?: string };
  assert.match(agent.think.prompt, /Alaa/);
  assert.match(agent.think.prompt, /unknown-tenant/, "nullable tenant defaulted, never null");
  assert.match(agent.think.prompt, /inbound call/);
  assert.deepEqual(agent.think.functions.map((f) => f.name).sort(), ["end_call", "express", "look", "show_image"]);
  assert.equal("greeting" in agent, false, "no greeting configured -> field omitted");

  // caller audio -> agent verbatim (base64 payload becomes a binary frame)
  ws.send(JSON.stringify({ type: "audio.frame", seq: 1, timestampMs: 20, payloadBase64: "UENNMTZL" }));
  await until(() => fakeAgent.sent.find((m) => m.type === "binary_audio" && m.audio === "UENNMTZL"));

  // agent audio (binary) -> worker audio.frame with seq/timestamp bookkeeping (640 bytes = 20ms)
  const pcm640 = Buffer.alloc(640);
  const audioP = nextMessage(ws);
  fakeAgent.emitAudio(pcm640);
  const frame1 = await audioP;
  assert.equal(frame1.type, "audio.frame");
  assert.equal(frame1.seq, 0);
  assert.equal(frame1.timestampMs, 0);

  const audio2P = nextMessage(ws);
  fakeAgent.emitAudio(pcm640);
  const frame2 = await audio2P;
  assert.equal(frame2.seq, 1);
  assert.equal(frame2.timestampMs, 20); // advanced by the first frame's real duration

  // barge-in: UserStartedSpeaking -> assistant.cancel; in-flight agent audio is
  // ghost-dropped until the agent's NEXT utterance starts
  const cancelP = nextMessage(ws);
  fakeAgent.emit({ type: "UserStartedSpeaking" });
  const cancel = await cancelP;
  assert.equal(cancel.type, "assistant.cancel");
  assert.equal(cancel.turnId, 0);

  fakeAgent.emitAudio(pcm640); // ghost - dropped
  const afterCancelP = nextMessage(ws);
  fakeAgent.emit({ type: "AgentStartedSpeaking" });
  fakeAgent.emitAudio(pcm640); // fresh utterance - relayed
  const frame3 = await afterCancelP;
  assert.equal(frame3.seq, 2, "ghost audio must be dropped, fresh audio relayed");

  // worker ping -> pong echoing ts
  const pongP = nextMessage(ws);
  ws.send(JSON.stringify({ type: "ping", ts: 12345 }));
  assert.deepEqual(await pongP, { type: "pong", ts: 12345 });

  // participants + dtmf -> context notes carried in UpdatePrompt
  ws.send(JSON.stringify({ type: "participants", count: 3 }));
  await until(() => fakeAgent.sent.find((m) => m.type === "UpdatePrompt" && String(m.prompt).includes("3 human participants")));
  ws.send(JSON.stringify({ type: "dtmf", digit: "7" }));
  const dtmfPrompt = await until(() => fakeAgent.sent.find((m) => m.type === "UpdatePrompt" && String(m.prompt).includes('"7"')));
  assert.match(String(dtmfPrompt.prompt), /3 human participants/, "earlier notes stay in the rolling context section");

  // client-side function: express -> expression to worker + function response to agent
  const exprP = nextMessage(ws);
  fakeAgent.emit({
    type: "FunctionCallRequest",
    functions: [{ id: "t1", name: "express", arguments: '{"emotion":"happy"}', client_side: true }],
  });
  const expr = await exprP;
  assert.deepEqual(expr, { type: "expression", emotion: "happy" });
  const exprRes = await until(() => fakeAgent.sent.find((m) => m.type === "FunctionCallResponse" && m.id === "t1"));
  assert.equal(exprRes.name, "express");
  assert.equal(exprRes.content, "expressing happy");

  // arguments as an already-parsed object are tolerated
  fakeAgent.emit({
    type: "FunctionCallRequest",
    functions: [{ id: "t1b", name: "express", arguments: { emotion: "surprised" } as never, client_side: true }],
  });
  await until(() => fakeAgent.sent.find((m) => m.type === "FunctionCallResponse" && m.id === "t1b" && m.content === "expressing surprised"));

  // server-side functions (client_side: false) are Deepgram's own - never answered by the bridge
  fakeAgent.emit({
    type: "FunctionCallRequest",
    functions: [{ id: "srv1", name: "server_lookup", arguments: "{}", client_side: false }],
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    fakeAgent.sent.some((m) => m.type === "FunctionCallResponse" && m.id === "srv1"),
    false,
    "server-side calls must not be answered by the bridge",
  );

  // client-side function: show_image (inline base64) -> display.image to worker
  const imgP = nextMessage(ws);
  fakeAgent.emit({
    type: "FunctionCallRequest",
    functions: [{ id: "t2", name: "show_image", arguments: JSON.stringify({ dataBase64: "aW1n", mime: "image/png", caption: "chart" }), client_side: true }],
  });
  const img = await imgP;
  assert.equal(img.type, "display.image");
  assert.equal(img.mime, "image/png");
  assert.equal(img.caption, "chart");
  await until(() => fakeAgent.sent.find((m) => m.type === "FunctionCallResponse" && m.id === "t2" && String(m.content).includes("shown")));

  // unknown tool -> error content, call keeps running
  fakeAgent.emit({ type: "FunctionCallRequest", functions: [{ id: "t3", name: "teleport", arguments: "{}", client_side: true }] });
  await until(() => fakeAgent.sent.find((m) => m.type === "FunctionCallResponse" && m.id === "t3" && String(m.content).includes("not implemented")));

  // inline show_image over the 5 MB cap -> tool error (same bound as the URL path)
  fakeAgent.emit({
    type: "FunctionCallRequest",
    functions: [{ id: "t3b", name: "show_image", arguments: JSON.stringify({ dataBase64: "A".repeat(7_100_000), mime: "image/png" }), client_side: true }],
  });
  const oversize = await until(() => fakeAgent.sent.find((m) => m.type === "FunctionCallResponse" && m.id === "t3b"));
  assert.match(String(oversize.content), /too large/);

  // SSRF: show_image with a metadata/loopback URL -> tool error, nothing displayed
  fakeAgent.emit({
    type: "FunctionCallRequest",
    functions: [{ id: "t4", name: "show_image", arguments: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }), client_side: true }],
  });
  const ssrfResult = await until(() => fakeAgent.sent.find((m) => m.type === "FunctionCallResponse" && m.id === "t4"));
  assert.match(String(ssrfResult.content), /private/);
  fakeAgent.emit({
    type: "FunctionCallRequest",
    functions: [{ id: "t5", name: "show_image", arguments: JSON.stringify({ url: "http://127.0.0.1:8080/secret.png" }), client_side: true }],
  });
  await until(() => fakeAgent.sent.find((m) => m.type === "FunctionCallResponse" && m.id === "t5" && String(m.content).includes("failed")));

  // malformed Deepgram frames (missing fields) are dropped without killing the call
  fakeAgent.emit({ type: "FunctionCallRequest" } as never);
  fakeAgent.emit({ type: "FunctionCallRequest", functions: [{ client_side: true }] } as never);
  fakeAgent.emit({ type: "Error" } as never);
  fakeAgent.emit({ type: "Warning" } as never);
  const alivePongP = nextMessage(ws);
  ws.send(JSON.stringify({ type: "ping", ts: 999 }));
  assert.deepEqual(await alivePongP, { type: "pong", ts: 999 }, "call must survive malformed Deepgram frames");

  // look with no video shared -> tool error
  fakeAgent.emit({ type: "FunctionCallRequest", functions: [{ id: "v1", name: "look", arguments: "{}", client_side: true }] });
  await until(() => fakeAgent.sent.find((m) => m.id === "v1" && String(m.content).includes("no video")));

  // buffer a screenshare frame; server A has NO vision endpoint -> look reports vision unavailable
  ws.send(JSON.stringify({
    type: "video.frame", source: "screenshare", ts: 1, width: 640, height: 360,
    mime: "image/jpeg", dataBase64: Buffer.from("jpegbytes").toString("base64"), participantName: "Sara",
  }));
  await new Promise((r) => setTimeout(r, 30)); // let the frame land in the buffer
  fakeAgent.emit({ type: "FunctionCallRequest", functions: [{ id: "v2", name: "look", arguments: JSON.stringify({ question: "what is on screen?" }), client_side: true }] });
  await until(() => fakeAgent.sent.find((m) => m.id === "v2" && String(m.content).includes("no vision endpoint")));

  // governor goodbye without a TTS model -> InjectAgentMessage with the exact text
  const late: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => late.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: "assistant.say", text: "Goodbye, thanks for calling." }));
  await until(() => fakeAgent.sent.find((m) => m.type === "InjectAgentMessage" && m.message === "Goodbye, thanks for calling."));
  await until(() => late.find((m) => m.type === "assistant.cancel")); // playback flushed before the goodbye
  // the injected goodbye is the agent speaking - it must relay (not muted)
  fakeAgent.emit({ type: "AgentStartedSpeaking" });
  fakeAgent.emitAudio(pcm640);
  await until(() => late.find((m) => m.type === "audio.frame"));

  // session.end -> both sides torn down
  ws.send(JSON.stringify({ type: "session.end", reason: "call-ended" }));
  await until(() => (fakeAgent.closed ? true : undefined));
  await until(() => (ws.readyState === WebSocket.CLOSED ? true : undefined));
});

test("bridge-side governor: time limit -> goodbye -> session.end to worker; injected goodbye stays audible", async () => {
  const fakeAgentC = new FakeAgent();
  const connectDgC = async (_c: BridgeConfig, _l: unknown, handlers: DgSessionHandlers): Promise<AgentPort> => {
    fakeAgentC.handlers = handlers;
    return fakeAgentC;
  };
  // 0.002 min = 120ms limit; grace 40ms since the InjectAgentMessage fallback has unknown duration
  const serverC = startServer({ ...cfg, maxCallMinutes: 0.002, goodbyeGraceMs: 40 }, connectDgC, null);
  await new Promise<void>((r) => serverC.once("listening", () => r()));
  const portC = (serverC.address() as AddressInfo).port;

  const callId = "call-governor-1";
  const ts = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${portC}/voice/msteams/stream/${callId}`, {
    headers: { "X-StandIn-Timestamp": String(ts), "X-StandIn-Signature": sign(cfg.workerSharedSecret, ts, callId) },
  });
  await new Promise<void>((r) => ws.once("open", () => r()));
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));

  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));

  // goodbye fallback fires at the limit, then session.end after the grace
  await until(() => fakeAgentC.sent.find((m) => m.type === "InjectAgentMessage" && String(m.message).includes("Time limit reached")));
  // regression: the agent's injected goodbye must still relay - a blanket mute
  // here would hang up in silence
  fakeAgentC.emit({ type: "AgentStartedSpeaking" });
  fakeAgentC.emitAudio(Buffer.alloc(640));
  await until(() => received.find((m) => m.type === "audio.frame"));
  const end = await until(() => received.find((m) => m.type === "session.end"));
  assert.equal(end.reason, "time-limit");
  // playback must be flushed BEFORE the goodbye so buffered agent audio can't delay it
  const cancelIdx = received.findIndex((m) => m.type === "assistant.cancel");
  const endIdx = received.findIndex((m) => m.type === "session.end");
  assert.ok(cancelIdx >= 0 && cancelIdx < endIdx, "assistant.cancel must precede session.end");
  await until(() => (fakeAgentC.closed ? true : undefined));
  await until(() => (ws.readyState === WebSocket.CLOSED ? true : undefined));
  serverC.close();
});

test("Deepgram socket close mid-call -> session.end(agent-disconnected) to worker", async () => {
  const callId = "call-dgclose-1";
  const ts = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/${callId}`, {
    headers: { "X-StandIn-Timestamp": String(ts), "X-StandIn-Signature": sign(cfg.workerSharedSecret, ts, callId) },
  });
  await new Promise<void>((r) => ws.once("open", () => r()));
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));

  const sentBefore = fakeAgent.sent.length;
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: { aadId: "aad-123", displayName: "Alaa" } }));
  // wait for THIS call's Settings (the shared fake still holds the previous test's)
  await until(() => fakeAgent.sent.slice(sentBefore).find((m) => m.type === "Settings"));

  fakeAgent.handlers.onClose(1006, "gone");
  const end = await until(() => received.find((m) => m.type === "session.end"));
  assert.equal(end.reason, "agent-disconnected");
  await until(() => (ws.readyState === WebSocket.CLOSED ? true : undefined));
});

test("deterministic goodbye: assistant.say with DEEPGRAM_TTS_MODEL -> exact TTS audio to worker, agent muted", async () => {
  const fakeAgentD = new FakeAgent();
  const connectDgD = async (_c: BridgeConfig, _l: unknown, handlers: DgSessionHandlers): Promise<AgentPort> => {
    fakeAgentD.handlers = handlers;
    return fakeAgentD;
  };
  const serverD = startServer({ ...cfg, ttsModel: "aura-2-thalia-en" }, connectDgD, null);
  await new Promise<void>((r) => serverD.once("listening", () => r()));
  const portD = (serverD.address() as AddressInfo).port;

  // stub the standalone-TTS REST call: 640 bytes of PCM = 20ms
  const pcm = Buffer.alloc(640, 7);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes("api.deepgram.com/v1/speak")) {
      return new Response(new Uint8Array(pcm), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as typeof fetch;

  try {
    const callId = "call-tts-1";
    const ts = Date.now();
    const ws = new WebSocket(`ws://127.0.0.1:${portD}/voice/msteams/stream/${callId}`, {
      headers: { "X-StandIn-Timestamp": String(ts), "X-StandIn-Signature": sign(cfg.workerSharedSecret, ts, callId) },
    });
    await new Promise<void>((r) => ws.once("open", () => r()));
    const received: Array<Record<string, unknown>> = [];
    ws.on("message", (d) => received.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
    await until(() => fakeAgentD.sent.find((m) => m.type === "Settings"));

    ws.send(JSON.stringify({ type: "assistant.say", text: "Goodbye now." }));
    const frame = await until(() => received.find((m) => m.type === "audio.frame"));
    assert.equal(frame.payloadBase64, pcm.toString("base64"), "exact synthesized PCM must reach the worker");
    assert.equal(fakeAgentD.sent.some((m) => m.type === "InjectAgentMessage"), false, "no agent fallback when TTS succeeds");
    // playback flushed before the goodbye, and the agent is muted while it plays -
    // even after AgentStartedSpeaking clears the barge-in ghost filter
    assert.ok(received.some((m) => m.type === "assistant.cancel"), "goodbye must flush playback first");
    const framesBefore = received.filter((m) => m.type === "audio.frame").length;
    fakeAgentD.emit({ type: "AgentStartedSpeaking" });
    fakeAgentD.emitAudio(Buffer.alloc(640, 9));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(received.filter((m) => m.type === "audio.frame").length, framesBefore, "agent audio is muted during deterministic goodbye");
    ws.close();
  } finally {
    globalThis.fetch = realFetch;
    serverD.close();
  }
});

test("caller audio during connect is buffered and flushed after Settings; duplicate session.start ignored; context notes land in the Settings prompt", async () => {
  const fakeAgentE = new FakeAgent();
  let releaseConnect: () => void = () => {};
  const gate = new Promise<void>((r) => (releaseConnect = r));
  const connectDgE = async (_c: BridgeConfig, _l: unknown, handlers: DgSessionHandlers): Promise<AgentPort> => {
    fakeAgentE.handlers = handlers;
    await gate; // simulate connect + Welcome latency
    return fakeAgentE;
  };
  const serverE = startServer(cfg, connectDgE, null);
  await new Promise<void>((r) => serverE.once("listening", () => r()));
  const portE = (serverE.address() as AddressInfo).port;

  const callId = "call-buffer-1";
  const ts = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${portE}/voice/msteams/stream/${callId}`, {
    headers: { "X-StandIn-Timestamp": String(ts), "X-StandIn-Signature": sign(cfg.workerSharedSecret, ts, callId) },
  });
  await new Promise<void>((r) => ws.once("open", () => r()));

  // caller starts talking immediately after session.start, before the socket is open;
  // a participants signal lands in the same window
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  ws.send(JSON.stringify({ type: "audio.frame", seq: 1, timestampMs: 0, payloadBase64: "Zmlyc3Q=" }));
  ws.send(JSON.stringify({ type: "audio.frame", seq: 2, timestampMs: 20, payloadBase64: "c2Vjb25k" }));
  ws.send(JSON.stringify({ type: "participants", count: 3 }));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} })); // duplicate - must be ignored
  await new Promise((r) => setTimeout(r, 40));
  releaseConnect();

  await until(() => (fakeAgentE.sent.filter((m) => m.type === "binary_audio").length >= 2 ? true : undefined));
  const chunks = fakeAgentE.sent.filter((m) => m.type === "binary_audio").map((m) => m.audio);
  assert.deepEqual(chunks, ["Zmlyc3Q=", "c2Vjb25k"], "buffered frames flush in order");
  const settingsIdx = fakeAgentE.sent.findIndex((m) => m.type === "Settings");
  const firstChunkIdx = fakeAgentE.sent.findIndex((m) => m.type === "binary_audio");
  assert.ok(settingsIdx >= 0 && settingsIdx < firstChunkIdx, "Settings must precede flushed audio");
  assert.equal(
    fakeAgentE.sent.filter((m) => m.type === "Settings").length, 1,
    "duplicate session.start must not open a second agent session",
  );
  const settings = fakeAgentE.sent[settingsIdx] as { agent: { think: { prompt: string } } };
  assert.match(
    settings.agent.think.prompt, /3 human participants/,
    "context that lands during the connect window rides the initial Settings prompt",
  );
  ws.close();
  serverE.close();
});

test("look uses vision path 2 (describe) when a vision endpoint is configured", async () => {
  const callId = "call-vision-1";
  const ts = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${portB}/voice/msteams/stream/${callId}`, {
    headers: { "X-StandIn-Timestamp": String(ts), "X-StandIn-Signature": sign(cfg.workerSharedSecret, ts, callId) },
  });
  await new Promise<void>((r) => ws.once("open", () => r()));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await until(() => fakeAgentB.sent.find((m) => m.type === "Settings"));

  ws.send(JSON.stringify({
    type: "video.frame", source: "camera", ts: 1, width: 640, height: 360,
    mime: "image/jpeg", dataBase64: Buffer.from("cam").toString("base64"),
  }));
  await new Promise((r) => setTimeout(r, 30));
  fakeAgentB.emit({ type: "FunctionCallRequest", functions: [{ id: "w1", name: "look", arguments: JSON.stringify({ question: "who is there?" }), client_side: true }] });
  const result = await until(() => fakeAgentB.sent.find((m) => m.type === "FunctionCallResponse" && m.id === "w1"));
  assert.match(String(result.content), /camera frame.*who is there\?/);
  ws.close();
});

test("custom tools: registered handler executes and its output goes back as the function response", async () => {
  const fakeAgentT = new FakeAgent();
  const connectDgT = async (_c: BridgeConfig, _l: unknown, handlers: DgSessionHandlers): Promise<AgentPort> => {
    fakeAgentT.handlers = handlers;
    return fakeAgentT;
  };
  const serverT = startServer(cfg, connectDgT, null, {
    tools: [
      {
        name: "lookup_order",
        description: "Look up an order.",
        parameters: { type: "object", properties: { orderNumber: { type: "string" } }, required: ["orderNumber"] },
        handler: async (params, ctx) => `order ${String(params.orderNumber)} for call ${ctx.callId}: shipped`,
      },
      {
        name: "broken_tool",
        description: "Always throws.",
        parameters: { type: "object", properties: {}, required: [] },
        handler: () => {
          throw new Error("backend down");
        },
      },
    ],
  });
  await new Promise<void>((r) => serverT.once("listening", () => r()));
  const portT = (serverT.address() as AddressInfo).port;

  const callId = "call-tools-1";
  const ts = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${portT}/voice/msteams/stream/${callId}`, {
    headers: { "X-StandIn-Timestamp": String(ts), "X-StandIn-Signature": sign(cfg.workerSharedSecret, ts, callId) },
  });
  await new Promise<void>((r) => ws.once("open", () => r()));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  const settings = await until(() => fakeAgentT.sent.find((m) => m.type === "Settings"));
  const names = ((settings.agent as Record<string, unknown>).think as { functions: Array<{ name: string }> }).functions.map((f) => f.name);
  assert.ok(names.includes("lookup_order"), "custom function schema must be in the Settings");
  assert.ok(names.includes("end_call"), "built-in functions must still be present");

  // happy path: handler output becomes the function response
  fakeAgentT.emit({
    type: "FunctionCallRequest",
    functions: [{ id: "ct1", name: "lookup_order", arguments: '{"orderNumber":"KO-1"}', client_side: true }],
  });
  const out = await until(() => fakeAgentT.sent.find((m) => m.type === "FunctionCallResponse" && m.id === "ct1"));
  assert.equal(out.content, `order KO-1 for call ${callId}: shipped`);

  // a throwing handler becomes an error output, never an uncaught exception
  fakeAgentT.emit({ type: "FunctionCallRequest", functions: [{ id: "ct2", name: "broken_tool", arguments: "{}", client_side: true }] });
  const err = await until(() => fakeAgentT.sent.find((m) => m.type === "FunctionCallResponse" && m.id === "ct2"));
  assert.match(String(err.content), /failed: backend down/);

  ws.close();
  serverT.close();
});

test("custom tools: a name colliding with a built-in bridge function fails at startup", () => {
  assert.throws(
    () =>
      startServer(cfg, connectDg, null, {
        tools: [{ name: "end_call", description: "x", parameters: { type: "object", properties: {} }, handler: () => "y" }],
      }),
    /collides with a built-in/,
  );
});

test("GET /metrics exposes call/relay counters in Prometheus format", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  const body = await res.text();
  assert.match(body, /# TYPE bridge_calls_total counter/);
  assert.match(body, /bridge_calls_total [1-9]/, "earlier tests in this file created calls");
  assert.match(body, /bridge_frames_to_worker_total [1-9]/);
  assert.match(body, /bridge_call_seconds_total (0\.0*[1-9]|[1-9])/, "call durations must accumulate");
  assert.match(body, /# TYPE bridge_calls_active gauge/);
});
