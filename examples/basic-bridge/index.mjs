/**
 * basic-bridge example: embed @komaa/deepgram-msteams-bridge in your own project.
 *
 * What it shows:
 *   1. loadConfig()  - the same env variables as the CLI (see ../../.env.example)
 *   2. a custom VisionDescriber - your own model answers the agent's `look` tool
 *      (path 2: the raw frame never leaves this process, only your description does)
 *   3. startServer() - the HTTP + WebSocket server StandIn dials into
 *
 * Run:  npm install && cp ../../.env.example .env  (fill it in)  && npm start
 *
 * With dummy env values the bridge starts and listens fine; a real Teams call
 * additionally needs a StandIn identity pointed at this server (see README.md).
 */
import { loadConfig, startServer } from "@komaa/deepgram-msteams-bridge";
import OpenAI from "openai";

// 1. Env-driven config, identical to the CLI. Throws a clear error when a
//    required variable is missing or a numeric one is not a number.
const cfg = loadConfig();

// 2. OPTIONAL: answer the agent's `look` tool with your own vision model.
//    The Deepgram Voice Agent API is audio-only, so this hook (or the
//    VISION_API_URL env equivalent) is the ONLY way the agent can see the
//    caller's camera/screen-share. Requires OPENAI_API_KEY for this example's
//    vision model; delete the block (and pass nothing as the third argument)
//    to run without vision.
const openai = new OpenAI(); // reads OPENAI_API_KEY (vision example only)

/** @type {import("@komaa/deepgram-msteams-bridge").VisionDescriber} */
const describeFrame = async (frame, question) => {
  // frame: { source: "camera"|"screenshare", mime, dataBase64, width, height,
  //          participantName?, participantId?, ts }
  const who = frame.source === "screenshare" ? "the caller's shared screen" : "the caller's camera";
  const res = await openai.chat.completions.create({
    model: process.env.EXAMPLE_VISION_MODEL || "gpt-4o-mini", // any vision-capable model
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `This is ${who}. ${question}` },
          {
            type: "image_url",
            image_url: { url: `data:${frame.mime};base64,${frame.dataBase64}`, detail: "low" },
          },
        ],
      },
    ],
  });
  return res.choices[0]?.message?.content ?? "I could not make out the image.";
};

// 3. OPTIONAL: extend the agent with your own tools.
//    - `tools`: client-side function tools the BRIDGE executes (your code,
//      your systems); they are declared in every session's Settings.
const tools = [
  {
    name: "lookup_order",
    description: "Look up the status of a customer order by its order number.",
    parameters: {
      type: "object",
      properties: { orderNumber: { type: "string", description: "The order number, e.g. KO-1234." } },
      required: ["orderNumber"],
    },
    async handler({ orderNumber }, ctx) {
      ctx.log.info(`lookup_order ${orderNumber}`);
      // call your own backend here; the returned string goes to the agent
      return `Order ${orderNumber} shipped yesterday and arrives tomorrow.`;
    },
  },
];

// 4. Start the bridge. StandIn dials {your-url}/{callId} per call with an
//    HMAC-signed upgrade; one Deepgram Voice Agent session is opened per call.
//    handleSignals: true opts into the built-in SIGINT/SIGTERM drain, which
//    ends every live call cleanly and THEN EXITS THE PROCESS - only enable it
//    when the bridge owns the process (as in this example).
startServer(cfg, undefined, describeFrame, { handleSignals: true, tools });

console.log("basic-bridge example is up.");
console.log(`Point your StandIn identity's agent WebSocket URL at ws://<this-host>:${cfg.port}/voice/msteams/stream`);
