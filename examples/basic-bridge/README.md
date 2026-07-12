# basic-bridge example

A minimal, runnable embedding of `@komaa/deepgram-msteams-bridge` with a custom vision hook.

```bash
npm install
cp ../../.env.example .env   # fill in DEEPGRAM_API_KEY and WORKER_SHARED_SECRET
npm start
```

The bridge listens on `PORT` (default 8080). Point your StandIn identity's agent
WebSocket URL at `wss://<your-host>/voice/msteams/stream` (front it with TLS, or set
`TLS_CERT_PATH`/`TLS_KEY_PATH`), call your bot in Microsoft Teams, and talk to the agent.

The custom `describeFrame` hook in [`index.mjs`](./index.mjs) answers the agent's `look`
tool with a chat-completions vision call: the raw Teams frame never leaves this process;
only the returned description reaches the Realtime conversation.
