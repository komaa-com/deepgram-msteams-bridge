---
title: "Contributing"
description: "Local setup, conventions, and where the full contributor guide lives."
---

Contributions are welcome. The full guide - local setup, conventions, and the release flow - lives in [`CONTRIBUTING.md`](https://github.com/komaa-com/deepgram-msteams-bridge/blob/main/CONTRIBUTING.md) in the repository.

## Quick start for contributors

```bash
git clone https://github.com/komaa-com/deepgram-msteams-bridge
cd deepgram-msteams-bridge
npm ci
npm test        # node:test suites via tsx (no network, no Deepgram account needed)
npm run typecheck
npm run build
```

- **One runtime dependency** (`ws`); everything else is dev-only.
- **The relay is copy-only at 16 kHz** - the Voice Agent session is pinned to `linear16` @ 16000, and the provider adapter (`deepgram.ts`) owns the base64/binary framing. Keep that boundary.
- **Tests use a fake `AgentPort`** (see `test/session.test.ts`), so the suite runs without a Deepgram account - including the `SettingsApplied` ordering gate and the barge-in ghost filter.
- **Docs live in `website/`** (this site). Any merged change to `website/` redeploys the site automatically.

## Documentation policy

Document how to **connect to** the hosted StandIn service and how the bridge behaves on the wire. Do not document the internals of the hosted media bridge - this repository only depends on its published wire contract.
