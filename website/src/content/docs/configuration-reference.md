---
title: "Configuration Reference"
description: "Every environment variable the bridge reads, with defaults and meaning."
---

The bridge is configured entirely from environment variables. The package ships a fully commented [`.env.example`](https://github.com/komaa-com/deepgram-msteams-bridge/blob/main/.env.example). Only two variables are required.

## Required

| Env | Meaning |
|---|---|
| `WORKER_SHARED_SECRET` | The shared secret from StandIn pairing. Must equal what StandIn holds, or the HMAC upgrade is rejected with `401`. |
| `DEEPGRAM_API_KEY` | Server-side Deepgram key. Opens Voice Agent sessions and calls Aura TTS. Never sent to the Teams side. |

## The agent

There is no dashboard - these variables define the agent:

| Env | Default | Meaning |
|---|---|---|
| `DEEPGRAM_LISTEN_MODEL` | `nova-3` | STT model for `agent.listen` (e.g. `nova-3`, `flux-general-en`). |
| `DEEPGRAM_THINK_PROVIDER` | `open_ai` | LLM provider for `agent.think` (`open_ai`, `anthropic`, `google`, `groq`, `aws_bedrock`, ...). |
| `DEEPGRAM_THINK_MODEL` | `gpt-4o-mini` | LLM model for `agent.think`. |
| `DEEPGRAM_THINK_ENDPOINT_URL` | unset | BYO-LLM endpoint - **required by Deepgram for third-party think providers** (google, groq, aws_bedrock); Deepgram-managed `open_ai`/`anthropic` work without it. Must be https; Deepgram dials it itself. |
| `DEEPGRAM_THINK_ENDPOINT_HEADERS` | unset | Headers for the think endpoint, as a JSON object (e.g. `{"authorization":"Bearer ..."}`). |
| `DEEPGRAM_SPEAK_MODEL` | `aura-2-thalia-en` | Aura voice for `agent.speak`. |
| `DEEPGRAM_LANGUAGE` | `en` | Agent language (set on the listen and speak providers). |
| `DEEPGRAM_PROMPT` | a built-in default | Base agent prompt. The bridge appends per-call caller context (name, tenant, direction) and live context notes. |
| `DEEPGRAM_GREETING` | unset | Deterministic opening line the agent speaks first (also the natural place for a spoken AI disclosure). |
| `DEEPGRAM_TTS_MODEL` | unset | Enables the deterministic governor goodbye via the standalone Aura TTS endpoint (exact text, agent muted, real duration). Without it, the goodbye is spoken verbatim by the live agent via `InjectAgentMessage`. |
| `DEEPGRAM_AGENT_HOST` | `agent.deepgram.com` | Voice Agent WebSocket host. Regional pins: `api.eu.deepgram.com`, `api.au.deepgram.com`. Restricted to `*.deepgram.com`. |
| `DEEPGRAM_API_HOST` | `api.deepgram.com` | REST host (goodbye TTS). Same regional pins and allowlist. |
| `DEEPGRAM_HOST_ALLOW_ANY` | unset | Set to `true` only to point the hosts at a deliberate trusted proxy/test host. |

:::caution
`DEEPGRAM_API_KEY` is sent as `Authorization: Token ...` to both hosts. They are allowlisted to `*.deepgram.com` precisely so a mistyped or attacker-influenced host cannot exfiltrate the key. Only set `DEEPGRAM_HOST_ALLOW_ANY=true` for a proxy you control.
:::

## Call governor

| Env | Default | Meaning |
|---|---|---|
| `MAX_CALL_MINUTES` | `0` (off) | Bridge-side hard cap per call, in minutes (fractional allowed). Deepgram knows nothing about your budget - enforce limits here. |
| `GOODBYE_TEXT` | a default line | The goodbye the bridge-side governor speaks. |
| `GOODBYE_GRACE_MS` | `8000` | How long to let the goodbye play out before ending the call when its duration is unknown (agent-spoken fallback). Always hard-bounded. |

## Vision (the `look` tool)

The Voice Agent API is audio-only, so the bridge answers `look` itself - and only via your endpoint:

| Env | Default | Meaning |
|---|---|---|
| `VISION_API_URL` | unset | Any OpenAI-compatible chat-completions endpoint with image input. **The raw frame is sent to this endpoint** (never to Deepgram) - run a local model (Ollama/vLLM) if frames must not leave your infrastructure. Without it, `look` reports vision unavailable. Validated at startup. |
| `VISION_API_KEY` | unset | Bearer key for the vision endpoint (local endpoints may not need one). |
| `VISION_MODEL` | unset | Vision model name (required when `VISION_API_URL` is set). |
| `VISION_REQUIRES_RECORDING` | `false` | Compliance gate: when `true`, the bridge refuses to send caller video frames to the vision endpoint unless Teams recording is `active`. |

## Server and transport

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | TCP port the bridge listens on. |
| `BIND` | `0.0.0.0` | Bind address. |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | unset | PEM cert/key for native TLS (`wss://`). Without both, the bridge serves plain WS and MUST be fronted by a TLS terminator. |
| `HMAC_FRESHNESS_MS` | `60000` | Allowed clock skew for the HMAC timestamp. |
| `MAX_CONNECTIONS` | `0` (= 64) | Max concurrent connections. |
| `MAX_CONNECTIONS_PER_IP` | `0` (= `MAX_CONNECTIONS`) | Per-IP cap. Defaults to the total cap (effectively off) because StandIn dials from a small set of IPs; set explicitly (with `TRUST_PROXY_XFF=true` behind a proxy you control) for a real limit. |
| `TRUST_PROXY_XFF` | `false` | Key the per-IP cap on the first `X-Forwarded-For` hop. Only behind a proxy you control. |
| `PRE_START_TIMEOUT_MS` | `0` (= 10000) | Drop a connection that authenticates but never sends `session.start`. |
| `WORKER_IDLE_TIMEOUT_MS` | `0` (= 90000) | Dead-peer window: end the call after this long without any worker message (the worker heartbeats every 30 s). Frees the call id for reconnect and closes the billed agent session. |
| `LOG_TRANSCRIPTS` | `false` | Log transcripts (`ConversationText`; still gated on Teams `recording.status == "active"`). |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. An invalid value falls back to `info`. |

The bridge also exposes `GET /metrics` (Prometheus text format, no auth): calls total/active, a call-duration **histogram** (`bridge_call_duration_seconds`, for p50/p95/p99) plus the cumulative seconds counter, upgrade rejections by cause, frames relayed each way, backpressure drops, and Deepgram connect failures. Like `/healthz` it is served on the same port - keep the port private to your network or scrape through your ingress.

:::note
Configuration **fails loud**: non-numeric or negative numerics, a non-`deepgram.com` host, a malformed `VISION_API_URL`, a non-https `DEEPGRAM_THINK_ENDPOINT_URL`, or invalid `DEEPGRAM_THINK_ENDPOINT_HEADERS` JSON all stop startup with a clear message rather than silently misbehaving.
:::

Audio formats are not configurable: the wire is PCM 16 kHz by contract and the Voice Agent session is pinned to `linear16` at 16 kHz both ways (the copy-only property).
