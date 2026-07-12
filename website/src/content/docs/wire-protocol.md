---
title: "Wire Protocol"
description: "The exact contract on both sockets: the HMAC upgrade, connection guards, every message the bridge relays, and the Voice Agent mapping."
---

The bridge terminates two protocols: the StandIn media bridge's worker protocol on one side, and the Deepgram Voice Agent WebSocket on the other. This page documents both. The StandIn side is identical to the sibling bridges - the implementations are interchangeable.

## The upgrade (StandIn side)

The StandIn media bridge opens one WebSocket per call to `{path}/{callId}` - the **call id is the last path segment** of the URL. The upgrade carries two headers:

| Header | Value |
|---|---|
| `X-StandIn-Timestamp` | Unix epoch milliseconds |
| `X-StandIn-Signature` | `HMAC-SHA256(secret, "{timestampMs}.{callId}")`, lowercase hex |

The legacy header names `X-OpenClawTeamsBridge-Timestamp` / `-Signature` are still accepted (the bridge checks the new names first); StandIn sends both pairs during the transition.

Verification (`401` on failure): the timestamp must be within the freshness window (`HMAC_FRESHNESS_MS`, default 60 s), the signature must match (constant-time compare), and the `(callId, ts, sig)` tuple must be **single-use** (a captured handshake cannot be replayed within the window). The bridge fails closed if the shared secret is unset. The call id is also cross-checked against the `session.start` body.

## Connection guards

| Guard | Value |
|---|---|
| Max concurrent connections | 64 (`MAX_CONNECTIONS`) |
| Per-IP cap | = total cap (`MAX_CONNECTIONS_PER_IP`) |
| Max inbound frame | 2 MB |
| Outbound backpressure cap | 1 MB (drops hot-path audio above it; control frames, one-shot images, and goodbye audio always pass) |
| Pre-start timeout | 10 s (`PRE_START_TIMEOUT_MS`) - drops a socket that never sends `session.start` |
| Worker idle timeout | 90 s (`WORKER_IDLE_TIMEOUT_MS`) - dead-peer detection: ends the call after 3 missed 30 s heartbeats, freeing the call id and the billed agent session |
| Duplicate call id | rejected with `409` - no second billed agent session for one call |

Audio on the StandIn wire is base64 **PCM 16 kHz, 16-bit, mono**; toward Deepgram it is the same `linear16` at 16 kHz, sent as raw binary frames.

## Worker to bridge

| Message | Fields | Bridge action |
|---|---|---|
| `session.start` | `callId`, `threadId`, `caller{aadId?, displayName?, tenantId?}`, `recordingStatus?`, `direction?` | Open the Voice Agent session; after `Welcome`, send `Settings` (prompt with caller name/tenant/direction, `linear16` @ 16k, models, greeting, functions). All caller fields are nullable and are defaulted, never sent as null. |
| `audio.frame` | `seq`, `timestampMs`, `payloadBase64`, `speakerName?` | Base64-decode, send as a raw binary frame. **Buffered until the server acks `SettingsApplied`**, then flushed oldest-first. In group calls, a changed `speakerName` becomes a rate-limited context note. |
| `video.frame` | `source` (`camera`/`screenshare`), `ts`, `width`, `height`, `mime`, `dataBase64`, `participantId?`, `participantName?` | Buffer the latest frame per source, in memory, for the on-demand `look` tool. Unknown sources are ignored. |
| `participants` | `count` | Context note appended to the prompt via `UpdatePrompt` ("N humans on the call, stay quiet unless addressed"). |
| `dtmf` | `digit` | Context note via `UpdatePrompt` ("the caller pressed {digit}"). |
| `ping` | `ts` | Reply `pong` with the same `ts`. |
| `recording.status` | `status` | Gate what may be persisted (transcripts; and `look` frames when `VISION_REQUIRES_RECORDING`). |
| `assistant.say` | `text` | Governor goodbye: speak it (Aura TTS or the live agent), backstop teardown armed, then StandIn tears the call down. |
| `session.end` | `reason` | Close the Voice Agent socket, tear down. |

## Bridge to worker

| Message | Fields | Meaning |
|---|---|---|
| `audio.frame` | `seq`, `timestampMs`, `payloadBase64` | Agent audio for the Teams side (base64 of the raw binary Deepgram frame). |
| `assistant.cancel` | `turnId` | Barge-in (or goodbye flush): flush queued playback on the Teams side. `turnId` is always `0` - the worker's flush ignores the value. |
| `expression` | `emotion` | Avatar emotion cue (from the agent's `express` function). |
| `display.image` | `dataBase64`, `mime`, `mode?`, `caption?`, ... | Show an image on the bot's video tile (from `show_image`). Never dropped under backpressure. |
| `pong` | `ts` | Reply to a worker `ping`. |
| `session.end` | `reason` | Ask StandIn to tear the call down (governor, agent `end_call`, or fatal error). |

## Deepgram Voice Agent side (mapping)

Endpoint: `wss://agent.deepgram.com/v1/agent/converse` (or the regional `api.eu` / `api.au` hosts), authenticated with `Authorization: Token <api key>`.

| Voice Agent message | Direction | Bridge behavior |
|---|---|---|
| `Welcome` | DG → bridge | Gates the connect: `Settings` is only sent after it arrives. |
| `Settings` | bridge → DG | Sent once: `audio.input/output` pinned to `linear16` @ 16 kHz (`container: none`), `agent.listen/think/speak` providers with language, prompt, optional greeting, optional `think.endpoint` (BYO LLM), and the functions list (built-ins + custom). |
| `SettingsApplied` | DG → bridge | The server is ready for audio. The bridge flushes buffered caller speech; a 10 s ack timeout ends the call rather than leaving it silent. |
| binary audio | both | Caller audio (bridge → DG) and agent audio (DG → bridge), raw `linear16` @ 16 kHz - relayed verbatim. |
| `UserStartedSpeaking` | DG → bridge | Caller barge-in: emit `assistant.cancel`, ghost-drop in-flight agent frames until `AgentStartedSpeaking`. |
| `AgentStartedSpeaking` | DG → bridge | Stop ghost-dropping (the deterministic-goodbye mute latch still wins). |
| `FunctionCallRequest` | DG → bridge | Client-side tool calls (`client_side` true): dispatch to `end_call` / `express` / `show_image` / `look` or a registered custom tool. Server-side calls (with an endpoint) are Deepgram's own and are ignored. |
| `FunctionCallResponse` | bridge → DG | The tool result (`{type, id, name, content}`). |
| `UpdatePrompt` | bridge → DG | Live context: caller context + a bounded rolling notes section (participants, DTMF, active speaker). The Voice Agent API has no non-interrupting context message, so context rides the prompt. |
| `InjectAgentMessage` | bridge → DG | The goodbye fallback when no Aura TTS model is set - the live agent speaks the exact text. |
| `ConversationText` | DG → bridge | Transcripts, logged only when `LOG_TRANSCRIPTS=true` **and** Teams recording is active. |
| `KeepAlive` | bridge → DG | Sent every 8 s so the session does not idle out during silence. |
| `Error` / `Warning` / `InjectionRefused` | DG → bridge | Logged; the call survives malformed or advisory frames. |
