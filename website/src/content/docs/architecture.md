---
title: "Architecture"
description: "How a call flows through the bridge, the copy-only audio property, the source-module map, and the trust and security model."
---

The bridge is a small, stateless-per-call relay. It holds two WebSockets per call - the StandIn media bridge on one side, a Deepgram Voice Agent session on the other - and mostly copies bytes between them.

## System overview

```mermaid
flowchart LR
    Teams["Microsoft Teams<br/>voice/video call"]
    StandIn["StandIn media bridge<br/>(hosted)<br/>joins the call, speaks<br/>the wire protocol"]
    Bridge["this bridge (Node/TS)<br/>verifies HMAC, terminates<br/>the wire protocol,<br/>one WS per call"]
    DG["Deepgram Voice Agent<br/>Nova STT + LLM + Aura TTS<br/>one session per call"]

    Teams <--> StandIn
    StandIn -- "HMAC WebSocket, 16 kHz" --> Bridge
    Bridge -- "Voice Agent WebSocket, 16 kHz" --> DG
    Bridge -. "relay audio verbatim,<br/>map barge-in, carry context,<br/>run tools and governors" .-> DG
```

The StandIn media bridge handles everything about Teams itself and exposes each call as a single WebSocket carrying `audio.frame` (PCM 16 kHz), `video.frame` (JPEG) and control messages. This bridge has no idea what is on the other end of the Teams call - it only speaks the wire protocol.

## The copy-only property

The StandIn wire is base64 **PCM 16 kHz, 16-bit, mono**. The Voice Agent session is pinned to `linear16` at 16 kHz both ways (`container: none`), so the hot path is **copy-only**: caller audio is base64-decoded into a binary frame, agent audio is base64-encoded onto the wire. No resampling, no re-encoding, nothing added to the latency budget beyond a relay hop. This matches the strictly transcode-free ElevenLabs sibling (the OpenAI sibling, by contrast, must resample to 24 kHz).

## Call lifecycle

```mermaid
flowchart TD
    A["upgrade + HMAC verify<br/>401 on bad / replayed / stale signature<br/>409 if callId already live"]
    B["session.start<br/>callId cross-checked vs the URL<br/>10s pre-start timeout if it never arrives"]
    C["connect Deepgram (Welcome-gated)<br/>send Settings: prompt + caller context,<br/>linear16 @ 16k, models, greeting, functions<br/>audio buffered until SettingsApplied (10s bound)"]
    D["relay<br/>audio.frame &lt;-&gt; binary frames, verbatim<br/>UserStartedSpeaking -&gt; assistant.cancel + ghost-drop<br/>participants / dtmf / speaker -&gt; UpdatePrompt notes<br/>look / show_image / express / end_call / custom tools"]
    E["teardown<br/>worker close, agent close, session.end,<br/>governor, or drain<br/>closes BOTH sockets once, clears timers,<br/>records call duration, de-registers the call"]

    A --> B --> C --> D --> E
```

Two ordering contracts are enforced on the Deepgram side: the `Settings` message is only sent after the server's `Welcome`, and **no caller audio flows until the server acks with `SettingsApplied`** (buffered up to ~5 s, bounded, then flushed oldest-first; a 10 s ack timeout ends the call rather than leaving it silent).

Barge-in: on `UserStartedSpeaking` the Voice Agent stops generating server-side; the bridge mirrors the cut to the Teams side with `assistant.cancel` and ghost-drops frames still in flight until the agent audibly starts its next utterance (`AgentStartedSpeaking`) - a state flag, so it cannot leak memory no matter how often the caller barges in.

## Source module map

| Module | Responsibility |
|---|---|
| `src/server.ts` | HTTP server + WS upgrade, HMAC validation, connection guards (caps, replay, pre-start, dup-callId 409), session registry, tool registry wiring, opt-in signal drain |
| `src/session.ts` | One call: the StandIn WS ⇄ Voice Agent WS relay, SettingsApplied gate, ghost-drop, governors, goodbye, tool dispatch (built-in + custom), context notes, vision buffering |
| `src/deepgram.ts` | Voice Agent socket (Welcome gate, KeepAlive, binary audio framing), Settings/prompt builders, function schemas, Aura TTS for the goodbye |
| `src/protocol.ts` | Wire message types (JSON, camelCase, discriminated on `type`) + PCM duration helper |
| `src/hmac.ts` | `HMAC-SHA256("{timestampMs}.{callId}")` sign/verify (constant-time), header names, freshness |
| `src/ssrf.ts` | Public-URL guard for the agent-supplied `show_image` fetch (one re-validated redirect hop) |
| `src/vision.ts` | Describe-then-answer vision hook (OpenAI-compatible endpoint) |
| `src/config.ts` | Env config, fail-loud numeric parsing, `*.deepgram.com` allowlists, think-endpoint and vision-URL validation |
| `src/cli.ts` | CLI entry point + friendly startup errors |
| `src/log.ts` / `src/metrics.ts` | Minimal leveled logger; Prometheus counters + call-duration histogram |

## Trust and security model

| Layer | Protection |
|---|---|
| Upgrade auth | `HMAC-SHA256("{timestampMs}.{callId}")`, constant-time compare, fails closed when the secret is unset |
| Replay | Single-use `(callId, ts, sig)` guard within a 60 s freshness window |
| Duplicate call | A second live connection for the same `callId` is rejected (`409`) - no second billed agent session |
| DoS | Max connections (64), per-IP cap (default = total cap), 2 MB inbound frame cap, 1 MB outbound backpressure cap (hot-path audio only - control frames, one-shot images and goodbye audio always pass), 10 s pre-start timeout, 90 s dead-peer window |
| Key hygiene | `DEEPGRAM_API_KEY` is server-side only, never sent to the Teams side; both Deepgram hosts are pinned to `*.deepgram.com` so the key cannot be exfiltrated to another host |
| SSRF | The agent-supplied `show_image` URL is resolved to public hosts only, connect-time DNS pinned against rebind, at most one re-validated redirect, bounded time and size |
| Tool bounds | Agent-supplied strings relayed to the worker are length-capped; unknown tools get an error result, never a crash |
| Crash safety | Every async entry point is guarded so a single malformed frame or throwing handler cannot take the process down |
| Shutdown | The opt-in signal drain (CLI) ends live calls (`session.end` + close); a second signal during the grace exits immediately |
