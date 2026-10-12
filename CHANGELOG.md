# Changelog

All notable changes to grokbot-bridge-plugin (the CLI `grokbot-bridge.mjs` and `SETUP_PROMPT.md`). Versions are git tags.

## 0.8.0 (2026-10-12)

`unenroll --yes [--reason <text>]`: run before a bot is deleted on the Grok Bot side. It calls the app's `POST unenroll` (app library 0.7.0+), which revokes the bot's token and shows the bot as removed in the app straight away, then forgets the token and rooms cache locally. A 401 (already revoked) still cleans up. Setup prompt: creator bots (Botfather) have a bot unenroll before deleting it (creator step 5).

## 0.7.0 (2026-10-12)

Request context. `verify` exposes the app's signed request context as `_bridge.context` on `direct` (from `payload.context`) and `room` (from `payload.requestContext`) messages: `persona`, `requester`, `project`, `chat`, `missionId` / `taskId` / `runId`, `owner`, `replyTo`, plus `memoryKey` (`persona:<id>`) and a `next` hint. Absent for apps that send none. Setup prompt rule 3: read the context, work for that persona and project, mention them when relevant, keep per-persona memory separate. Pairs with `@infernos/grokbot-bridge-next` 0.6.0.

## 0.6.0 (2026-10-12)

Slack wake mode. `verify --slack [<file> | -]` reads a `GB-WAKE v1` message an app posted in a Slack channel, extracts and base64-decodes the original webhook body (checking its length and sha256), and verifies it exactly like a webhook body (HMAC, freshness, dedupe). Exit 4 = the wake is addressed to another bot; ignore it. `enroll --inbound-url slack` or `slack:#channel` enrolls in Slack mode (the app must support it, e.g. agent-os). Replies still go over the bridge with `send`; never post in Slack.

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
