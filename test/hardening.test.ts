import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { ReplayGuard, authorizeUpgrade, callIdFromUrl } from "../src/server.js";
import { sign, TIMESTAMP_HEADER, SIGNATURE_HEADER } from "../src/hmac.js";
import { loadConfig, type BridgeConfig } from "../src/config.js";

const SECRET = "test-secret";

const baseCfg: BridgeConfig = {
  port: 0,
  host: "127.0.0.1",
  workerSharedSecret: SECRET,
  deepgramApiKey: "x",
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
  visionApiUrl: null,
  visionApiKey: null,
  visionModel: null,
  maxCallMinutes: 0,
  goodbyeText: "bye",
  goodbyeGraceMs: 8000,
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

function req(callId: string, ts: number, sig: string): IncomingMessage {
  return {
    url: `/voice/msteams/stream/${callId}`,
    headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: sig },
    socket: { remoteAddress: "1.2.3.4" },
  } as unknown as IncomingMessage;
}

test("ReplayGuard: a verified tuple is single-use within the window", () => {
  const g = new ReplayGuard(60_000);
  const now = 1_000_000;
  const ts = now - 1_000; // fresh: within the 60s window of `now`
  assert.equal(g.claim("callA", ts, "sigA", now), true, "first use accepted");
  assert.equal(g.claim("callA", ts, "sigA", now), false, "replay rejected");
  assert.equal(g.claim("callA", ts + 1, "sigA", now), true, "different ts is a different tuple");
});

test("ReplayGuard: records expire once the timestamp is no longer fresh", () => {
  const g = new ReplayGuard(60_000);
  const t0 = 1_000_000;
  assert.equal(g.claim("callB", t0, "sigB", t0), true);
  // advance well past t0 + window: the old record is swept when the next claim runs
  const later = t0 + 120_000;
  assert.equal(g.claim("callC", later, "sigC", later), true);
  assert.equal(g.size, 1, "expired entry swept");
});

test("authorizeUpgrade: replays are rejected even with a valid signature", () => {
  const g = new ReplayGuard(60_000);
  const ts = Date.now();
  const sig = sign(SECRET, ts, "callD");
  assert.deepEqual(authorizeUpgrade(baseCfg, req("callD", ts, sig), g), { callId: "callD" });
  const second = authorizeUpgrade(baseCfg, req("callD", ts, sig), g);
  assert.ok("error" in second && /replay/i.test(second.error), "second identical upgrade is a replay");
});

test("authorizeUpgrade: fail-closed on an empty shared secret", () => {
  const ts = Date.now();
  const sig = sign(SECRET, ts, "callE");
  const res = authorizeUpgrade({ ...baseCfg, workerSharedSecret: "" }, req("callE", ts, sig));
  assert.ok("error" in res && /not configured/.test(res.error), "empty secret rejects all");
});

test("Deepgram hosts are restricted to deepgram.com (API-key exfil guard)", () => {
  const saved = { ...process.env };
  try {
    process.env.WORKER_SHARED_SECRET = SECRET;
    process.env.DEEPGRAM_API_KEY = "dg_x";

    process.env.DEEPGRAM_AGENT_HOST = "agent.deepgram.com";
    process.env.DEEPGRAM_API_HOST = "api.deepgram.com";
    assert.equal(loadConfig().agentHost, "agent.deepgram.com", "default hosts allowed");

    process.env.DEEPGRAM_AGENT_HOST = "evil.example.com";
    assert.throws(() => loadConfig(), /not a deepgram\.com host/, "arbitrary agent host rejected");

    process.env.DEEPGRAM_AGENT_HOST = "agent.deepgram.com";
    process.env.DEEPGRAM_API_HOST = "evil.example.com";
    assert.throws(() => loadConfig(), /not a deepgram\.com host/, "arbitrary REST host rejected");

    process.env.DEEPGRAM_HOST_ALLOW_ANY = "true";
    assert.equal(loadConfig().apiHost, "evil.example.com", "explicit override honored");
  } finally {
    process.env = saved;
  }
});

// A malformed percent-escape in the upgrade path must NOT throw (that would be
// an uncaught exception -> process crash, pre-auth).
test("callIdFromUrl returns null for a malformed percent-escape (no throw)", () => {
  assert.equal(callIdFromUrl("/voice/msteams/stream/%zz"), null);
  assert.equal(callIdFromUrl("/%E0%A4%A"), null); // truncated escape
  assert.equal(callIdFromUrl("/voice/stream/call%20123"), "call 123"); // valid still decodes
});

test("authorizeUpgrade rejects a malformed-escape URL instead of throwing", () => {
  const badReq = { url: "/voice/msteams/stream/%zz", headers: {}, socket: {} } as unknown as IncomingMessage;
  const res = authorizeUpgrade({ ...baseCfg, workerSharedSecret: SECRET }, badReq, new ReplayGuard(60_000));
  assert.ok("error" in res && res.error === "no callId in path");
});

// Fail-loud on negative numerics (a typo like MAX_CALL_MINUTES=-1 would otherwise
// pass Number.isFinite and silently disable the governor).
test("loadConfig throws on a negative MAX_CALL_MINUTES", () => {
  const saved = { ...process.env };
  try {
    process.env.WORKER_SHARED_SECRET = "s";
    process.env.DEEPGRAM_API_KEY = "k";
    process.env.MAX_CALL_MINUTES = "-1";
    assert.throws(() => loadConfig(), /MAX_CALL_MINUTES.*must not be negative/);
  } finally {
    process.env = saved;
  }
});

// VISION_API_URL sends caller video frames somewhere - validate it at startup.
test("VISION_API_URL is validated at config load", () => {
  const saved = { ...process.env };
  try {
    process.env.WORKER_SHARED_SECRET = "s";
    process.env.DEEPGRAM_API_KEY = "k";

    process.env.VISION_API_URL = "not a url";
    assert.throws(() => loadConfig(), /VISION_API_URL.*not a valid URL/);

    process.env.VISION_API_URL = "ftp://vision.example.com/api";
    assert.throws(() => loadConfig(), /must be http\(s\)/);

    process.env.VISION_API_URL = "https://user:pass@vision.example.com/api";
    assert.throws(() => loadConfig(), /embedded credentials/);

    process.env.VISION_API_URL = "http://127.0.0.1:11434/v1/chat/completions"; // local Ollama: allowed (warned)
    assert.equal(loadConfig().visionApiUrl, "http://127.0.0.1:11434/v1/chat/completions");
  } finally {
    process.env = saved;
  }
});
