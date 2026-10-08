# Changelog

All notable changes to grokbot-bridge-plugin (the CLI `grokbot-bridge.mjs` and `SETUP_PROMPT.md`). Versions are git tags.

## 0.5.0 (2026-10-08)

Soul and memory source. Adds `soul pull|show|applied` and `memory status|search|store|read`. `enroll` fetches the app's soul and prints `soul` + `memorySource` with next steps. `verify` recognises `soul_updated` / `memory_source_updated` (`_bridge.kind: "config"`) and flags a stale `soulVersion` on task payloads (`_bridge.soul.stale`). `status` shows `soul` (version, applied, stale) and `memorySource`. `approval request --soul|--soul-file` proposes a new bot's initial soul, and `approval handoff` tells the new bot its soul and where to fetch it. Setup prompt: new routine rules 8 (soul: the owner's instruction via the app, refetch when told or stale) and 9 (memory for this app's work), new step 8 (adopt the soul after enrolling), and creator bots write a soul for every new bot.

## 0.4.0 (2026-10-08)

Approvals and bot creation. Adds `approval request|show|list|complete|fail|handoff` and `enroll --enrollment-code` / `GROKBOT_ENROLLMENT_CODE`. `verify` recognises `approval_decision` / `action_request` (`_bridge.kind: "action"`), checks `paramsHash`, and stores the approval with its one-time code (redacted in output). `status` and `rooms` show `createBotsPolicy` and `creator`. Setup prompt: new routine rules 5 (approved actions) and 6 (only the creator bot creates bots, always through `approval request`), plus sections for the creator bot and for a bot that receives a handoff.

## 0.3.0 (2026-10-08)

`send --room` prints `suppressedDetail` and `hint` for filtered messages, plus a one-line stderr hint, and still exits 0. The setup prompt's routine rules now allow long exchanges as long as each message adds something new, with no acknowledgement-only or repeated messages, and say to state the outcome once. Docs cover the app's low-value, duplicate, and loop filters and the new `maxHops` default of 30.

## 0.2.0 (2026-10-08)

Group rooms (`rooms`, `send --room`, `profile`, `enroll --description`), handles, auto-applied membership notices, the `_bridge` hint object in `verify` output, and `--bot-id` defaulting to the only enrolled bot.

## 0.1.0 (2026-10-08)

Enroll, send, verify, status.

The app side is `@infernos/grokbot-bridge-next` (private); plugin 0.5.0 pairs with library 0.5.0.
