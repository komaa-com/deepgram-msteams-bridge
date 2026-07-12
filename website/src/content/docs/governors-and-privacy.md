---
title: "Governors and Privacy"
description: "The two call governors, the deterministic goodbye, the recording gate, the vision data-flow, and Deepgram retention guidance."
---

## Two governors

Both governors end a call gracefully - the caller hears a goodbye rather than a sudden drop.

### StandIn-side (tier limits)

When a StandIn tier limit is reached (a sandbox/free daily cap or a subscription max-minutes governor), StandIn sends an `assistant.say` with the goodbye text. The bridge speaks it and StandIn tears the call down. If StandIn ever fails to hang up afterwards, the bridge's own backstop ends the call after the goodbye grace plus a hard cap - a call can never sit open with the agent muted.

### Bridge-side (`MAX_CALL_MINUTES`)

Because Deepgram knows nothing about your budget, the bridge can enforce its own hard cap. Set `MAX_CALL_MINUTES` (fractional allowed; `0` disables it). At call start the bridge arms a timer; on expiry it flushes playback, speaks `GOODBYE_TEXT`, and ends the call with reason `time-limit`.

## Deterministic goodbye

The goodbye is the exact `GOODBYE_TEXT` on both paths:

- Set `DEEPGRAM_TTS_MODEL` and it is synthesized via the standalone Aura TTS endpoint - the agent is muted while it plays, and the real audio duration is used for the grace.
- Without it, the **live agent** speaks the exact text via `InjectAgentMessage` (which can be refused mid-utterance, `InjectionRefused`; the backstop still ends the call), and `GOODBYE_GRACE_MS` covers the unknown duration.

:::note
The goodbye can never wedge a call open (a hard-bounded teardown deadline is armed before waiting, and the Aura fetch is time-bounded), and its audio is **never dropped** under worker backpressure - unlike disposable hot-path audio, the last thing the caller hears is load-bearing.
:::

## Recording gate

StandIn reports the Teams recording state (`recording.status`). The bridge honors it:

- Transcripts (`ConversationText`) are never logged or persisted unless `LOG_TRANSCRIPTS=true` **and** recording is `active`.
- With `VISION_REQUIRES_RECORDING=true`, the `look` tool refuses to send caller video frames to the vision endpoint unless recording is `active`.
- Video frames are buffered in memory only and dropped at teardown.

## Vision data-flow (read this)

The Voice Agent API is audio-only, so `look` is answered by **your** vision endpoint. The raw camera/screen frame is **never sent to Deepgram**, but it **is sent to the endpoint you configure** via `VISION_API_URL` (OpenAI, Azure, or a local model). For deployments that must not share caller video with a third party, point `VISION_API_URL` at a local Ollama/vLLM instance, or leave it unset (the agent then simply has no vision). `VISION_REQUIRES_RECORDING=true` adds a consent-signal gate on top.

## Data residency and retention

Caller audio, transcripts, and any vision descriptions transit Deepgram's cloud (and the configured think provider) and are retained per your Deepgram data settings. For deployments that must keep traffic in-region, set `DEEPGRAM_AGENT_HOST` and `DEEPGRAM_API_HOST` to the regional pins (`api.eu.deepgram.com` / `api.au.deepgram.com`). Disclose that an AI is on the call - a spoken `DEEPGRAM_GREETING` is the simplest way, and follows most tenants' call-recording/AI-disclosure policy.
