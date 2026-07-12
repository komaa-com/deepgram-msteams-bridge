# Microsoft Teams Bridge for Deepgram Voice Agents

[![CI](https://github.com/komaa-com/deepgram-msteams-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/komaa-com/deepgram-msteams-bridge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@komaa/deepgram-msteams-bridge.svg)](https://www.npmjs.com/package/@komaa/deepgram-msteams-bridge)
[![docs](https://img.shields.io/badge/docs-komaa--com.github.io-2563eb.svg)](https://komaa-com.github.io/deepgram-msteams-bridge/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**`@komaa/deepgram-msteams-bridge`** puts a [Deepgram Voice Agent](https://developers.deepgram.com/docs/voice-agent) on a real **Microsoft Teams call**.

> **Prefer Python?** The same bridge exists as a Python package: [`deepgram-msteams-bridge` on PyPI](https://pypi.org/project/deepgram-msteams-bridge/) ([repo](https://github.com/komaa-com/deepgram-msteams-bridge-py)) - same wire protocol, same environment variables, drop-in interchangeable behind the same `.env` file. The hosted **StandIn media bridge** ([standin.komaa.com](https://standin.komaa.com)) joins the Teams call and dials into this bridge over an HMAC-authenticated WebSocket; the bridge opens one Deepgram Voice Agent session per call (Nova STT + your chosen LLM + Aura TTS, all run by Deepgram) and relays between them.

```text
Microsoft Teams call
       |
       v
StandIn media bridge        (hosted; joins the call)
       |   HMAC WebSocket, PCM 16 kHz
       v
this bridge                 (you run it)
       |   WebSocket, linear16 @ 16 kHz
       v
Deepgram Voice Agent        (STT + LLM + TTS + turn-taking)
```

The hot path is **copy-only**: the StandIn wire is base64 PCM 16 kHz mono and the Voice Agent session is pinned to `linear16` at 16 kHz both ways, so caller audio and agent audio are relayed **verbatim** in both directions. No resampling, no re-encoding, no transcoding.

## Features

- **Realtime voice, end to end** - the caller talks to your Deepgram agent and hears it reply. Turn-taking, VAD and interruption are the Voice Agent's own (server-side); the bridge adds nothing to the latency budget beyond a relay hop.
- **No dashboard to configure** - the bridge configures each session itself from environment variables: STT model (`nova-3`), LLM (Deepgram-managed `open_ai`/`anthropic`, or any BYO provider via `DEEPGRAM_THINK_ENDPOINT_URL`), voice (`aura-2-thalia-en`), prompt, greeting.
- **Barge-in done right** - when the caller interrupts (`UserStartedSpeaking`), the bridge cancels playback on the Teams side and ghost-drops in-flight agent audio until the agent's next utterance, so no stale audio plays after the cut.
- **Per-call personalization** - caller name, tenant and call direction are injected into the agent prompt at session start; a deterministic greeting (`DEEPGRAM_GREETING`) doubles as a spoken AI disclosure.
- **Built-in agent tools** - `end_call`, `express` (avatar emotion), `show_image` (image on the bot's video tile, SSRF-guarded), `look` (vision). Declared as client-side functions in every session; behavior is implemented by the bridge.
- **Extensible tools** - register your own client-side function tools (`lookup_order`, `transfer_call`, ...) that the bridge executes in-process. See [Extending the agent's tools](#extending-the-agents-tools).
- **Vision on demand** - the `look` tool answers from the caller's camera or screen-share via any OpenAI-compatible vision endpoint (the Voice Agent API is audio-only, so this is the one vision route). Know the data flow: the raw frame IS sent to the vision endpoint YOU configure - never to Deepgram - and an optional `VISION_REQUIRES_RECORDING=true` gates it on Teams recording being active.
- **Live context without interruptions** - participant counts, DTMF digits and active-speaker changes ride `UpdatePrompt` as a bounded rolling context section, so the agent knows what is happening without being interrupted.
- **Two call governors** - a StandIn-side cutoff the bridge speaks a goodbye for, and a bridge-side `MAX_CALL_MINUTES` hard cap. The goodbye is the exact text: standalone Aura TTS when `DEEPGRAM_TTS_MODEL` is set, otherwise spoken by the live agent via `InjectAgentMessage`. Both paths are backstopped so a call can never sit open half-dead.
- **Observability** - `GET /healthz` for liveness and `GET /metrics` (Prometheus text format): calls, durations, rejects, relay/drop counters.
- **Hardened transport** - replay-proof HMAC upgrade, single-use handshake guard, connection caps, payload caps, backpressure bounds, pre-start timeout, dead-peer detection, duplicate-call rejection, opt-in graceful signal drain, and a `*.deepgram.com` host allowlist so your API key can only be sent to Deepgram.

## Install

Run it directly:

```bash
npx @komaa/deepgram-msteams-bridge
```

Or add it to your project:

```bash
npm install @komaa/deepgram-msteams-bridge
```

Node.js `>= 20`. One runtime dependency (`ws`).

## Quick start

### 1. As a CLI (env-configured)

Set the two required variables, then run it:

```bash
export DEEPGRAM_API_KEY=dg_...
export WORKER_SHARED_SECRET=...
npx @komaa/deepgram-msteams-bridge
```

Optionally shape the agent (all have defaults):

```bash
export DEEPGRAM_PROMPT="You are Komaa's friendly receptionist. Keep replies short."
export DEEPGRAM_GREETING="Hello! You've reached Komaa. How can I help?"
export DEEPGRAM_SPEAK_MODEL=aura-2-thalia-en
export DEEPGRAM_THINK_MODEL=gpt-4o-mini
```

Or keep them in a `.env` file (copy [`.env.example`](./.env.example), which ships with the package) and load it:

```bash
node --env-file=.env node_modules/.bin/deepgram-msteams-bridge
```

### 2. As a library

```ts
import { loadConfig, startServer } from "@komaa/deepgram-msteams-bridge";

// env-configured, same variables as the CLI
startServer(loadConfig());
```

Signal handling is opt-in for embedders: the built-in SIGTERM/SIGINT drain ends every live call gracefully and **then exits the process**, so it is only wired when you ask for it (the CLI does). Enable it when the bridge owns the process:

```ts
startServer(loadConfig(), undefined, undefined, { handleSignals: true });
```

### 3. Connect it to StandIn

StandIn dials in **from the internet**, so expose port 8080 (tunnel or public host), then register the URL on your identity in the [StandIn dashboard](https://standin.komaa.com/dashboard):

```bash
tailscale funnel --bg --https=8080 8080
# Agent voice URL: wss://<machine>.<tailnet>.ts.net:8080/voice/msteams/stream
```

Place a Teams call to your bot (or join the [sandbox](https://standin.komaa.com/sandbox) meeting). StandIn joins, connects to the bridge, and your Deepgram agent answers.

## Extending the agent's tools

The four built-in tools are just the default registry. Register your own client-side function tools; the bridge declares them in every session's Settings, executes your handler when the agent calls them, and returns the handler's string as the function result. A thrown error becomes an error result the model can recover from.

```ts
import { loadConfig, startServer, type CustomTool } from "@komaa/deepgram-msteams-bridge";

const tools: CustomTool[] = [{
  name: "lookup_order",
  description: "Look up the status of a customer order by its order number.",
  parameters: {
    type: "object",
    properties: { orderNumber: { type: "string", description: "e.g. KO-1234" } },
    required: ["orderNumber"],
  },
  async handler({ orderNumber }, ctx) {
    ctx.log.info(`lookup_order ${String(orderNumber)}`);
    return await myBackend.orderStatus(String(orderNumber)); // the agent speaks this
  },
}];

startServer(loadConfig(), undefined, undefined, { tools });
```

Keep handlers fast (the caller is waiting on the answer) and enforce your own timeout for slow backends. Names must not collide with the built-ins. Server-side functions (Deepgram executing your HTTP endpoint directly) are a Voice Agent feature too - declare those on your own via a custom `Settings` if you need them; the bridge only answers `client_side` calls.

## Vision (`look` tool)

The Voice Agent API is audio-only, so the bridge answers the agent's `look` calls itself: the latest camera/screen-share frame goes to **your** OpenAI-compatible vision endpoint (`VISION_API_URL` / `VISION_MODEL`, or a custom `VisionDescriber` in code) and the text description returns as the function result. Without a vision endpoint, `look` tells the agent vision is unavailable.

**Know the data flow.** The raw frame is never sent to Deepgram - but it IS sent to the vision endpoint you configure (OpenAI, Azure, or a local Ollama/vLLM if you point `VISION_API_URL` at one). Camera and screen-share frames are PII-bearing in most jurisdictions: if your deployment requires consent signals before processing them, set `VISION_REQUIRES_RECORDING=true` and the bridge refuses to send any frame to the vision endpoint unless Teams recording is active. The returned description additionally becomes Voice Agent conversation content, retained per your Deepgram data settings. Run a local vision model if frames must not leave your infrastructure.

## Call governors

Two governors can end a call gracefully; both speak before hanging up:

- **StandIn-side:** when a tier limit is reached, StandIn sends `assistant.say` with the goodbye text; the bridge speaks it and StandIn tears the call down.
- **Bridge-side** (`MAX_CALL_MINUTES` > 0): the bridge arms a timer at call start. On expiry it flushes playback, speaks `GOODBYE_TEXT`, waits for the audio to play out (real TTS duration, or `GOODBYE_GRACE_MS` when unknown, always hard-bounded), then ends the call with reason `time-limit`. Use this when the billing limit lives with you, since Deepgram knows nothing about your budget.

The goodbye is deterministic either way: standalone Aura TTS (`DEEPGRAM_TTS_MODEL`, exact text, agent muted while it plays) or the live agent speaking the exact text via `InjectAgentMessage`. Both paths are backstopped: if whichever side is supposed to hang up never does, the bridge force-ends the call after the grace plus a hard cap.

## Disconnects and reconnects

If the worker socket drops mid-call, the bridge tears the call down: the Voice Agent session is closed and the `callId` is freed. There is **no mid-call re-attach**: a StandIn retry with the same `callId` after teardown is a fresh call with a fresh agent session and no conversation memory; a retry arriving while the old session is still live is rejected with `409` so one call can never pay for two agent sessions. If the Deepgram socket drops instead, the bridge ends the Teams call with `session.end(agent-disconnected)`. A silent dead peer is detected after 90 s (3 missed worker heartbeats) and the billed agent session is closed.

## Privacy / recording gate

StandIn reports the Teams recording state (`recording.status`). The bridge honors it:

- Transcripts (`ConversationText`) are never logged or persisted unless `LOG_TRANSCRIPTS=true` **and** recording is `active`.
- With `VISION_REQUIRES_RECORDING=true`, the `look` tool refuses to send caller video frames to the vision endpoint unless recording is `active` (off by default so vision stays usable without recording - an explicit trade-off; see Vision above).
- Video frames are buffered in memory only and dropped at teardown.

Caller audio and any vision descriptions transit Deepgram's cloud (and the configured think provider) per your Deepgram data settings; disclose the AI on the call via `DEEPGRAM_GREETING`. Regional routing: set `DEEPGRAM_AGENT_HOST=api.eu.deepgram.com` / `api.au.deepgram.com` (and the matching `DEEPGRAM_API_HOST`) to keep traffic in-region.

## Repository layout

```
src/
  server.ts      HTTP + WS upgrade, HMAC validation, connection guards, session registry, tool registry
  session.ts     per-call relay: StandIn WS <-> Deepgram Voice Agent WS, tools, governors, context
  deepgram.ts    Voice Agent socket (Settings, KeepAlive, binary audio framing), Aura TTS, prompt builders
  protocol.ts    wire message types (JSON, camelCase, discriminated on "type")
  hmac.ts        HMAC-SHA256("{timestampMs}.{callId}") hex, constant-time verify
  ssrf.ts        public-URL guard for agent-supplied fetches (one re-validated redirect)
  vision.ts      describe-then-answer vision hook
  config.ts      env config (fail-loud numeric parsing, host allowlists)
examples/        runnable example projects
website/         docs site (Astro Starlight), deployed to GitHub Pages
test/            node:test suites (run with tsx; no Deepgram account needed)
```

## Documentation

- **Docs site:** [komaa-com.github.io/deepgram-msteams-bridge](https://komaa-com.github.io/deepgram-msteams-bridge/) - getting started, architecture, configuration and library API reference, wire protocol, tool extensibility, troubleshooting.
- **Example project:** [`examples/basic-bridge/`](./examples/basic-bridge/) - a runnable embedding with a custom vision hook and a custom tool.
- **StandIn (the hosted service):** [standin.komaa.com](https://standin.komaa.com) · [docs.komaa.com](https://docs.komaa.com).
- **Siblings:** the same bridge exists for [ElevenLabs](https://github.com/komaa-com/elevenlabs-msteams-bridge), [LiveKit](https://github.com/komaa-com/livekit-msteams-bridge), and [OpenAI Realtime](https://github.com/komaa-com/openai-msteams-bridge) - same wire protocol, same hardening, pick the agent platform that fits.

## Contributing

PRs welcome - see [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup and conventions.

## License

[MIT](./LICENSE)
