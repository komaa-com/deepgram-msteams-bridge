---
title: "Vision and Tools"
description: "The four built-in tools the bridge registers on every session: end_call, express, show_image, and look (with the vision data-flow caveat)."
---

The agent drives the Teams side through **client-side functions**. Unlike agent platforms where you define tools in a dashboard, the bridge **registers these automatically** in every session's `Settings` (under `agent.think.functions`, with no endpoint, so Deepgram routes the call back to the bridge). The agent calls a function, the bridge executes it and returns the result as a `FunctionCallResponse`.

To add your own tools, see [Extending the Agent's Tools](/deepgram-msteams-bridge/extending-tools/).

## `look` - see the caller's camera or screen

Parameters: optional `source` (`camera` or `screenshare`) and `question`. The Voice Agent API is **audio-only** (no image input), so the bridge answers `look` itself: it takes the latest buffered video frame and describes it via **your** vision endpoint.

- If `VISION_API_URL` / `VISION_MODEL` are set (or you pass a custom `VisionDescriber` in code), the frame goes to that endpoint and the text description returns as the function result.
- Without a vision endpoint, `look` tells the agent vision is unavailable.

:::caution
**Know the data flow.** The raw frame is never sent to Deepgram - but it **is** sent to the vision endpoint you configure (OpenAI, Azure, or a local Ollama/vLLM if you point `VISION_API_URL` at one). Camera and screen-share frames are PII-bearing in most jurisdictions. Set `VISION_REQUIRES_RECORDING=true` to refuse sending any frame unless Teams recording is active, and run a local vision model if frames must not leave your infrastructure. The returned description additionally becomes Voice Agent conversation content, retained per your Deepgram data settings.
:::

## `show_image` - put an image on the bot's tile

Parameters: either inline `{dataBase64, mime}` or `{url}` (jpeg/png), plus optional `caption`. The bridge sends a `display.image` to the Teams side.

:::caution
A `url` is agent-controlled, i.e. indirectly caller-controlled. The bridge SSRF-guards it: public hosts only, connect-time DNS pinned against rebind, at most **one redirect hop** (the redirect target is re-validated through the same guard), and bounded fetch time and size (5 MB).
:::

## `express` - avatar emotion

Parameter: `{emotion}`. The bridge forwards an `expression` cue so the bot's avatar reflects the agent's sentiment.

## `end_call` - hang up

The agent decides the call is done (the caller said goodbye, or asked to hang up). The bridge acknowledges the function, sends `session.end` to StandIn, and tears down both sockets.

## Group-call awareness (no tool needed)

The bridge feeds the agent non-interrupting context automatically, carried in the prompt via `UpdatePrompt` (the Voice Agent API has no separate context message): participant counts ("N humans on the call, stay quiet unless directly addressed"), DTMF key presses, and - in group calls - a rate-limited note when the active speaker changes. This helps the agent stay quiet in meetings until addressed.
