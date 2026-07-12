---
title: "Getting Started"
description: "Install the bridge, configure the two required variables, connect a StandIn identity, and make your first Teams call to a Deepgram Voice Agent."
---

By the end of this page a Deepgram Voice Agent answers a Microsoft Teams call. You need Node.js `>= 20`, a Deepgram API key, and a StandIn identity (the sandbox is enough).

There is **no agent to set up in a dashboard**: the bridge configures each Voice Agent session itself (STT model, LLM, voice, prompt, greeting, tools) from your environment variables.

## 1. Install and run the bridge

As a CLI:

```bash
DEEPGRAM_API_KEY=dg_... \
WORKER_SHARED_SECRET=... \
  npx @komaa/deepgram-msteams-bridge
```

Or embedded in your own project:

```bash
npm install @komaa/deepgram-msteams-bridge
```

```ts
import { loadConfig, startServer } from "@komaa/deepgram-msteams-bridge";

startServer(loadConfig()); // same env variables as the CLI
```

Every option is an environment variable; the package ships a fully commented [`.env.example`](https://github.com/komaa-com/deepgram-msteams-bridge/blob/main/.env.example), and the [Configuration Reference](/deepgram-msteams-bridge/configuration-reference/) documents each one. The bridge listens on `0.0.0.0:8080` by default and exposes `GET /healthz` for liveness checks.

`WORKER_SHARED_SECRET` comes from StandIn in the next step.

## 2. Shape the agent (optional, recommended)

The defaults work out of the box (`nova-3` STT, `open_ai/gpt-4o-mini` thinking, `aura-2-thalia-en` voice); these variables define the personality:

```bash
DEEPGRAM_PROMPT="You are Komaa's friendly receptionist. Keep replies short; you are speaking aloud on a phone call."
DEEPGRAM_GREETING="Hello! You've reached Komaa. How can I help?"
DEEPGRAM_SPEAK_MODEL=aura-2-thalia-en
DEEPGRAM_THINK_MODEL=gpt-4o-mini
```

The bridge appends per-call caller context (name, tenant, direction) to your prompt automatically, and registers the built-in tools (`end_call`, `look`, `show_image`, `express`) on every session. Third-party LLMs (google, groq, aws_bedrock) additionally need `DEEPGRAM_THINK_ENDPOINT_URL` - see the [Configuration Reference](/deepgram-msteams-bridge/configuration-reference/).

## 3. Connect a StandIn identity

StandIn is the hosted service that joins the Teams call and dials into your bridge. Pick a tier at [standin.komaa.com](https://standin.komaa.com) (sandbox for an instant trial), pair, and you get a **shared secret**.

1. Put the secret in `WORKER_SHARED_SECRET` (both sides must match exactly).
2. Point the identity's **agent WebSocket URL** at your bridge, for example `wss://dg-bridge.example.com:8080/voice/msteams/stream`. StandIn appends `/{callId}` per call.
3. Restart the bridge if you changed the env.

StandIn dials in **from the internet**, so a laptop or private host needs a public URL. A tunnel gives you one and terminates TLS (so you get `wss://` for free). Run one pointing at port `8080`, then use the `wss://…/voice/msteams/stream` form of the printed host:

Tailscale Funnel:

```bash
tailscale funnel --bg --https=8080 8080
```

Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:8080
```

ngrok:

```bash
ngrok http 8080
```

VS Code dev tunnels:

```bash
devtunnel host -p 8080 --allow-anonymous
```

For a fixed production host use an ingress/load balancer, or serve TLS natively with `TLS_CERT_PATH` + `TLS_KEY_PATH`. Never give StandIn a plain `ws://` URL outside local testing.

More detail (tiers, what pairing does, cutoff behavior): [Connecting to StandIn](/deepgram-msteams-bridge/connecting-to-standin/).

## 4. Make the first call

Call your Teams bot (or join the sandbox meeting). In the bridge logs you should see the call arrive, the Voice Agent session open, and the relay start:

```text
INFO  [server] worker connected for call 19:meeting_ab... (1/64)
INFO  [call:19:meeting_ab] session.start (direction=inbound, recording=unknown)
INFO  [call:19:meeting_ab] Deepgram Voice Agent session open; waiting for SettingsApplied
INFO  [call:19:meeting_ab] SettingsApplied; relaying
```

Speak, and the agent answers in its own voice. If the call connects but something is off, [Troubleshooting](/deepgram-msteams-bridge/troubleshooting/) maps every error you are likely to see (`401` handshake, `agent-unavailable`, a missing think endpoint) to its cause.
