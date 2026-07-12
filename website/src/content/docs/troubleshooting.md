---
title: "Troubleshooting"
description: "The errors you will actually see on the upgrade, on the call, and at startup, and what each one means."
---

## `401` on the upgrade

The HMAC handshake failed. Causes:

- **Secret mismatch** - `WORKER_SHARED_SECRET` does not equal the value StandIn holds from pairing. They must match exactly.
- **Clock skew** - the timestamp is outside the freshness window (`HMAC_FRESHNESS_MS`, default 60 s). Sync the clocks (NTP).
- **Replayed handshake** - the same `(callId, ts, sig)` tuple was already used. This is the single-use guard doing its job; a genuine retry uses a fresh timestamp.
- **Secret unset** - the bridge fails closed if `WORKER_SHARED_SECRET` is empty; every upgrade is rejected.

## `409` Conflict

A live session already owns that call id (a retry or rollout reconnect). The bridge rejects the duplicate so it does not open a second billed agent session for one call. It clears when the first session tears down (a silent dead peer clears after the 90 s idle window).

## `503` Service Unavailable

A connection cap was hit: `MAX_CONNECTIONS` (default 64) or `MAX_CONNECTIONS_PER_IP` (default = the total cap). Raise them for a busier deployment, or check for a client that is not closing sockets.

## Call connects, then `agent-unavailable`

The bridge could not open (or configure) the Deepgram Voice Agent session. The log line carries the underlying error. Common causes:

- `DEEPGRAM_API_KEY` is invalid or lacks Voice Agent access.
- No `Welcome` within the timeout (network / host issue).
- **No `SettingsApplied` within 10 s** - the server did not accept the `Settings`. This most often means a `Settings` field it rejected: an invalid model name, or a third-party `DEEPGRAM_THINK_PROVIDER` without the required `DEEPGRAM_THINK_ENDPOINT_URL`.

## Third-party LLM does nothing / call fails at start

Deepgram-managed think providers (`open_ai`, `anthropic`) work with just `DEEPGRAM_THINK_MODEL`. Third-party providers (`google`, `groq`, `aws_bedrock`, ...) **require** `DEEPGRAM_THINK_ENDPOINT_URL` (+ `DEEPGRAM_THINK_ENDPOINT_HEADERS` for auth) - Deepgram dials that endpoint itself. Without it the `Settings` is rejected and the call ends with `agent-unavailable`.

## Call ends with `goodbye-timeout`

A goodbye was spoken (StandIn-side `assistant.say`) but nobody tore the call down within the grace window plus the hard cap. This is the bridge's backstop doing its job; check the StandIn connection if it recurs.

## Governor never fires

`MAX_CALL_MINUTES` must be a number. A non-numeric or negative value stops startup with a clear error (numeric env vars fail loud), so if the process started, the value parsed. Confirm it is greater than `0` (`0` disables the governor).

## Startup error about a Deepgram host

`DEEPGRAM_AGENT_HOST` / `DEEPGRAM_API_HOST` are restricted to `*.deepgram.com` so the API key can only be sent to Deepgram. Use the default or a regional pin (`api.eu.deepgram.com` / `api.au.deepgram.com`); set `DEEPGRAM_HOST_ALLOW_ANY=true` only for a proxy you control.

## Startup error about `VISION_API_URL` or the think endpoint

Both are validated at startup and fail loud: `VISION_API_URL` must be a well-formed http(s) URL without embedded credentials (a private-IP host is allowed for local endpoints, with a warning); `DEEPGRAM_THINK_ENDPOINT_URL` must be https without embedded credentials (put auth in `DEEPGRAM_THINK_ENDPOINT_HEADERS`, a JSON object).

## `look` says vision is unavailable

No `VISION_API_URL` (or custom `VisionDescriber`) is configured - the Voice Agent API is audio-only, so the bridge has no other way to see. Configure a vision endpoint. If `VISION_REQUIRES_RECORDING=true`, `look` also refuses until Teams recording is active.

## `show_image` fails on a URL

The URL is SSRF-guarded: public hosts only, at most one redirect hop (re-validated), 5 MB and 10 s bounds, jpeg/png only. A private/metadata address, a second redirect, or an oversized body is refused by design - the agent receives the failure as its function result and can tell the caller.

## Port already in use

The CLI prints a friendly hint on `EADDRINUSE`. Set `PORT` to a free port.

## Where the logs are

The bridge logs one line per event to stdout/stderr, scoped by call id. Set `LOG_LEVEL=debug` for the verbose relay detail (an invalid value falls back to `info`). Transcript logging additionally requires `LOG_TRANSCRIPTS=true` and Teams recording to be active.
