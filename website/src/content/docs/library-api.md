---
title: "Library API"
description: "Embed the bridge in your own Node project: startServer options, custom tools, vision hooks, custom agent transports, HMAC helpers, protocol types."
---

The package is both a CLI and an importable TypeScript library. Everything below is exported from the package root and fully typed.

```ts
import { loadConfig, startServer } from "@komaa/deepgram-msteams-bridge";
```

## Run the bridge in your own service

`loadConfig()` reads the same environment variables as the CLI and throws a clear error when a required variable is missing or a numeric one is not a number. `startServer(cfg)` returns the Node `http.Server`.

```ts
import { loadConfig, startServer } from "@komaa/deepgram-msteams-bridge";

const server = startServer(loadConfig());
server.on("listening", () => console.log("bridge up"));
```

### Signal handling is opt-in

The built-in SIGTERM/SIGINT drain ends every live call gracefully (`session.end` + close) and **then exits the process**. Because a library must never exit its host, it is only wired when you ask for it (the CLI does):

```ts
startServer(loadConfig(), undefined, undefined, { handleSignals: true });
```

A second signal during the drain grace exits immediately. Leave it off when the bridge is embedded in a larger service and wire your own shutdown.

## Custom function tools

`StartServerOptions.tools` registers client-side function tools the **bridge executes**. Each entry is a name, description, JSON schema, and handler; the handler's returned string goes back to the agent as the `FunctionCallResponse` content, and a throw becomes an error result the model can recover from.

```ts
import { loadConfig, startServer, type CustomTool } from "@komaa/deepgram-msteams-bridge";

const tools: CustomTool[] = [
  {
    name: "lookup_order",
    description: "Look up the status of a customer order by its order number.",
    parameters: {
      type: "object",
      properties: { orderNumber: { type: "string", description: "e.g. KO-1234" } },
      required: ["orderNumber"],
    },
    async handler({ orderNumber }, ctx) {
      // ctx: { callId, participantCount, recordingActive, log }
      ctx.log.info(`lookup_order ${String(orderNumber)}`);
      return await myBackend.orderStatus(String(orderNumber)); // the agent speaks this
    },
  },
];

startServer(loadConfig(), undefined, undefined, { tools });
```

Names must not collide with the built-ins (`end_call`, `express`, `show_image`, `look`) - collisions and duplicates fail at startup. Keep handlers fast (the caller is waiting on the answer) and enforce your own timeout for slow backends. See [Extending the Agent's Tools](/deepgram-msteams-bridge/extending-tools/) for the trust model.

## Custom vision hook

The third argument to `startServer` is a `VisionDescriber` - your own answer to the agent's `look` tool.

```ts
import OpenAI from "openai";
import { loadConfig, startServer, type VisionDescriber } from "@komaa/deepgram-msteams-bridge";

const openai = new OpenAI();

const describe: VisionDescriber = async (frame, question) => {
  // frame: { source: "camera" | "screenshare", mime, dataBase64, width, height, participantName?, ... }
  const who = frame.source === "screenshare" ? "the caller's shared screen" : "the caller's camera";
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `This is ${who}. ${question}` },
          { type: "image_url", image_url: { url: `data:${frame.mime};base64,${frame.dataBase64}`, detail: "low" } },
        ],
      },
    ],
  });
  return res.choices[0]?.message?.content ?? "I could not make out the image."; // becomes the `look` result
};

startServer(loadConfig(), undefined, describe);
```

The frame is passed to your describer (and, in this example, on to OpenAI) - it never reaches Deepgram. Pass `null` as the third argument to disable vision entirely; omit it to use the built-in `makeVisionDescriber(cfg)`, driven by `VISION_API_URL`.

## Custom agent transport (testing)

The second argument to `startServer` is a `DgConnector` - a factory that returns an `AgentPort`. The default opens a real Voice Agent socket; tests substitute a fake so no network or API key is needed.

```ts
import { startServer, loadConfig, type DgConnector, type AgentPort } from "@komaa/deepgram-msteams-bridge";

const fakeConnector: DgConnector = async (_cfg, _log, handlers) => {
  const port: AgentPort = {
    isOpen: true,
    sendAudioChunk() {},
    sendSettings() {},
    updatePrompt() {},
    injectAgentMessage() {},
    sendFunctionCallResponse() {},
    close() {},
  };
  // push server->bridge events with handlers.onMessage(...) and audio with handlers.onAudio(...)
  return port;
};

startServer(loadConfig(), fakeConnector, null);
```

The repository's own [test suite](https://github.com/komaa-com/deepgram-msteams-bridge/tree/main/test) uses exactly this shape.

## HMAC helpers

```ts
import { sign, verify, isFresh, TIMESTAMP_HEADER, SIGNATURE_HEADER } from "@komaa/deepgram-msteams-bridge";

const ts = Date.now();
const signature = sign(secret, ts, callId); // HMAC-SHA256(secret, `${ts}.${callId}`) hex
// send as headers X-StandIn-Timestamp / -Signature
verify(secret, ts, callId, signature); // constant-time, false on any missing input
isFresh(ts, 60_000);                   // within the freshness window?
```

## Deepgram-side helpers

Exported for tooling and tests: `DeepgramAgentSocket`, `buildSettings`, `buildPrompt`, `synthesizeGoodbye`, `customToolSchema`, `BRIDGE_FUNCTIONS`, and the `WIRE_SAMPLE_RATE` constant (16000).

## Protocol types

All wire message types are exported for building or validating messages: `SessionStartMessage`, `AudioFrameMessage`, `VideoFrameMessage`, `ParticipantsMessage`, `DtmfMessage`, `AssistantSayMessage`, `AssistantCancelMessage`, `ExpressionMessage`, `DisplayImageMessage`, the `WorkerInbound` / `WorkerOutbound` unions, plus `parseWorkerMessage()` and `pcm16kBytesToMs()`. See the [Wire Protocol](/deepgram-msteams-bridge/wire-protocol/) for the full contract.

## Also exported

- `authorizeUpgrade`, `callIdFromUrl`, `ReplayGuard` - the upgrade-authorization primitives.
- `CallSession` - the per-call relay class (advanced embedding).
- `assertPublicHttpUrl`, `isForbiddenIp`, `readBodyWithCap`, `fetchPublicImage` - the SSRF-guard primitives.
- `renderMetrics`, `logger` - metrics text and the minimal leveled logger.
