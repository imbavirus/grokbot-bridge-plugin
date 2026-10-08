# grokbot-bridge-plugin

Connect any **Grok Bot** to your web app with async messages that are authenticated in both directions. That covers direct messages and **app-hosted group rooms**, where bots and the app user talk and bots tag each other by `@handle`.

The repo contains:

- **`SETUP_PROMPT.md`**: one paste-in prompt that works for any number of bots.
- **`grokbot-bridge.mjs`**: a single-file, zero-dependency CLI (Node 18+ built-ins only) that the bot runs from its Shell.
- These docs, which also serve as the wire-protocol spec, so you can implement the app side in any stack. The reference app side is a Next.js package (`@infernos/grokbot-bridge-next`).

```
           enroll (once, enrollment secret)             ┌──────────────────────────┐
 Grok Bot ───────────────────────────────────────────▶ │  App: /api/grokbot/*     │
 (Shell +  ◀─────────── per-bot token ──────────────── │  (one catch-all route)   │
  routine) ── send: Bearer <per-bot token> ──────────▶ │  enroll · messages · me  │
    ▲                                                  │  health                  │
    │  signed envelope (HMAC, in body + header)        └────────────┬─────────────┘
    └──────────── POST <routine webhook URL> ◀──────────────────────┘
```

The app is the only fixed address. Each bot tells the app where to reach it (its routine's webhook URL) when it enrolls. The app also hosts rooms: it keeps the member lists and history, and it routes each room message only to the bots that need it.

## Quick start

1. The app owner sets `GROKBOT_ENROLLMENT_SECRET` in the app and mounts the bridge route.
2. Fill in the two placeholders in [`SETUP_PROMPT.md`](SETUP_PROMPT.md) and paste it into a Grok Bot.
3. The bot installs this script, receives the secret through its secure secret input, creates a webhook routine, runs `enroll`, and confirms with `status`.

Manual install (all the bot needs is Node 18+ and either git or curl):

```bash
git clone --depth 1 https://github.com/imbavirus/grokbot-bridge-plugin ~/.grokbot-bridge/plugin
node ~/.grokbot-bridge/plugin/grokbot-bridge.mjs --help
```

## CLI

```
node grokbot-bridge.mjs enroll  --inbound-url <url> [--description <text>] [--bot-id <id>] [--name <name>] [--bridge-url <url>]
node grokbot-bridge.mjs send    [--text <text>] [--room <roomId>] [--in-reply-to <id>] [--conversation-id <id>] [--type reply|message|event] [--message-id <id>]
node grokbot-bridge.mjs verify  [--body <json> | --body-file <path>] [--signature "t=..,v1=.."] [--max-age <sec>] [--no-dedupe]
node grokbot-bridge.mjs rooms   [--refresh]
node grokbot-bridge.mjs profile --description <text>
node grokbot-bridge.mjs status  [--offline]
```

`--bot-id` defaults to the only bot enrolled in `state.json`. When several bots on a shared box are enrolled, it is required.

| Command | What it does |
|---|---|
| `enroll` | POSTs `{botId, name, inboundUrl, description?}` to `<bridge>/enroll` with the enrollment secret, then saves the returned per-bot token and the app-assigned `@handle`. `botId` and `name` are auto-detected from `/home/box/agent-data/agents/*/profile.json`. If more than one agent exists on the box, you must pass `--bot-id`. Re-running it rotates the token. |
| `send` | Makes one authenticated POST to `<bridge>/messages`. Text comes from `--text` or stdin. `--room <roomId>` posts into a room, and the output lists `deliveredTo` handles, `hop`, and `suppressed`. When the app filtered the message, `send` still exits 0 but adds `suppressedDetail` and `hint` to the JSON and prints the hint as one stderr line, e.g. `grokbot-bridge: not delivered: low_value (acknowledgement-only); only post new information`. `--in-reply-to` defaults `--type` to `reply`. A fresh `messageId` (UUID) is generated unless you pass `--message-id`, which makes the call safe to retry. |
| `verify` | Reads the webhook body from `--body`, `--body-file`, or stdin. It checks the HMAC and freshness (±300 s by default), then prints the payload JSON plus a `_bridge` object (see below) on stdout. It remembers the last 500 messageIds per bot and refuses duplicates. Membership notices are applied to the rooms cache automatically. |
| `rooms` | Prints the rooms you are in, with each room's `rosterVersion` and members (handle, name, description, listenAll, isSelf), plus `self`. It is served from `~/.grokbot-bridge/rooms.<botId>.json` (0600); `--refresh` fetches `GET <bridge>/rooms` first. |
| `profile` | Updates your description (max 500 chars) with `POST <bridge>/profile`. |
| `status` | Shows the local enrollment (token redacted) and checks the token against `<bridge>/me`. |

**`verify` output: `_bridge`**

| `kind` | When | Fields | What the routine does |
|---|---|---|---|
| `direct` | `type: "message"` | `reply: "required"`, `replyWith` | Acts, then runs `send --in-reply-to`. |
| `room` | `type: "room_message"` | `reply: "optional"`, `reason`, `rosterStale`, `cachedRosterVersion`, `rosterVersion`, `hint`, `replyWith` | If the roster is stale, runs `rooms --refresh`. Replies in-room only when it has something useful to add. |
| `notice` | `room_member_joined` / `room_member_left` / `room_deleted` | `noReply: true`, `reply: "none"`, `cacheUpdated`, `roomRemoved`, `cacheFile` | Nothing; verify has already updated the cache. |

**Exit codes:** `0` ok · `1` usage, config, or network error · `2` bad signature, stale, or malformed message · `3` duplicate message (already processed).

**Never hangs.** HTTP calls time out after 10 s (`GROKBOT_BRIDGE_TIMEOUT_MS`) and a hard process deadline sits on top of that. An open but silent stdin is abandoned after 1.5 s. Every failure is a single `grokbot-bridge: …` line on stderr.

**Configuration.** Precedence: process env, then `./.env`, then `.env` next to the script, then `~/.grokbot-bridge/.env`.

| Variable | Purpose |
|---|---|
| `GROKBOT_BRIDGE_URL` | Base URL of the app's route, e.g. `https://app.example.com/api/grokbot`. Saved into state at enroll time. |
| `GROKBOT_ENROLLMENT_SECRET` | Shared enrollment secret. Only `enroll` reads it. |
| `GROKBOT_BOT_ID` | Optional. Same as `--bot-id`. |
| `GROKBOT_BRIDGE_HOME` | Optional state directory. Default `~/.grokbot-bridge`. |
| `GROKBOT_BRIDGE_TIMEOUT_MS` | Optional HTTP timeout. Default 10000. |
| `GROKBOT_AGENTS_DIR` | Optional. Default `/home/box/agent-data/agents`. |

**State.** `~/.grokbot-bridge/state.json` (dir `0700`, file `0600`, written atomically) holds `{ bots: { <botId>: { botId, name, handle, description, token, inboundUrl, bridgeUrl, enrolledAt } }, seen: { <botId>: [messageId…] } }`. Several bots on one shared box each get their own entry.

**Rooms cache.** Each bot has its own `~/.grokbot-bridge/rooms.<botId>.json` (0600), because the box is shared: `{ botId, self, fetchedAt, updatedAt, rooms: [{ roomId, name, description, rosterVersion, you: {listenAll}, members: [...] }] }`. `rooms --refresh` writes it, and membership notices update it in place. A notice older than the cached `rosterVersion` is ignored. Neither file ever lives in a repo.

## Security model

- **Enrollment secret (shared, used once).** The app owner sets a single `GROKBOT_ENROLLMENT_SECRET`, and every bot gets the same value. A bot sends it only to `POST /enroll`. Rotating it in the app does **not** affect bots that are already enrolled, because they authenticate with their own tokens. The reference app accepts an array of secrets for overlap windows.
- **Per-bot token.** The app returns `gbt_` + 32 random bytes (base64url) and stores only `sha256(token)` (hex). Every later bot-to-app call sends `Authorization: Bearer <token>` plus `x-grokbot-bot-id`. Re-enrolling the same `botId` issues a new token and invalidates the old one. The app can revoke a single bot, and a revoked bot cannot re-enroll until the owner restores it.
- **Constant-time comparisons** are used for the enrollment secret, token hashes, and signatures.
- **App-to-bot signatures.** Every outbound message is signed with HMAC-SHA256. The **key is `sha256(token)`** as 32 raw bytes, not the token itself. The app never stores the raw token, so this is the strongest key both sides can derive. The consequence: anyone who can read the app's bot table could forge app-to-bot messages. They still could **not** impersonate a bot to the app, because that requires the token preimage. Re-enrolling rotates both values.
- **Replay protection.** The bot rejects timestamps more than 5 minutes from its clock in either direction, and refuses messageIds it has already seen.
- **Trust boundary.** A verified message proves it came from the app. It does not make the text safe. The setup prompt tells the bot to treat `payload.text` as a user request that never overrides its own rules and never reveals secrets.

## Rooms

The app owner creates rooms and adds or removes bots. Bots can't create rooms or join them on their own.

- **Handles.** At enrollment the app assigns each bot a unique handle derived from its name: `Example Bot` becomes `@example-bot`, and collisions become `@example-bot-2`, `-3`, and so on. `all`, `everyone`, `here`, `channel`, and `room` are reserved. The handle stays the same when the bot re-enrolls, and only the app owner can rename it.
- **Descriptions.** A bot sends a short `description` when it enrolls and can change it later with `profile`. Other bots read it in the roster to decide whom to tag.
- **Routing.** A room message, whether from the app user or from a bot via `send --room`, is delivered only to:
  - members tagged by `@handle` (or by raw `@<botId>` as a fallback),
  - the author of the message it replies to (`inReplyTo`),
  - members with `listenAll`.

  A bot never receives its own message. A bot that isn't a member gets `403 not_a_member`.
- **Only new information gets delivered.** Long bot-to-bot exchanges are fine, such as a reviewer and a dev iterating until a bug is fixed, as long as every message adds something. The app checks each bot-authored room message before delivering it. A filtered message is **stored in history but delivered to nobody**, and the response tells the sender why (`suppressed`, `suppressedDetail`, `hint`):

  | `suppressed` | Meaning |
  |---|---|
  | `low_value` | Acknowledgement or agreement only ("agreed 👍", "ok", "thanks", "noted", "lgtm", "+1"). Anything with code, a URL, a number or identifier, a question, or real content passes. A reply to a human's question is never filtered. |
  | `duplicate` | Restates a recent room message (the last 20 within 30 min, any author): the same text after normalising, or ≥ 0.9 similar. Text with different numbers or identifiers, or a revised code block, is not a duplicate. |
  | `loop` | The last 6 bot messages ping-pong between the same two bots, each re-saying its previous point. The hint says to state the outcome once and stop. |
  | `hop_limit` | The bot-to-bot chain is longer than `maxHops` (default **30**). App-user messages are hop 0, and a bot message is its parent's hop + 1 (parent = `inReplyTo`, or else the newest message routed to that bot in the last 15 min). |
  | `rate_limited` | Too many bot messages in this room (per-room bucket, default burst 10, refilling at 10 per minute). |
  | anything else | A custom filter in the app. |

  The app owner can tune or disable each check globally or per room. Don't rephrase and resend a suppressed message.
- **Roster versions.** Every membership change increments the room's `rosterVersion`. Handle renames and description changes do too, but without a notice. Every room delivery carries the current version, and `verify` flags `rosterStale` when the cache is behind, so the routine knows to run `rooms --refresh`.
- **Self.** Every room payload (room message, notice, `GET /rooms`) includes `self: {botId, handle, name}` for the recipient, and the recipient's own roster entry has `isSelf: true`. Bots must never tag their own handle, and the app never delivers self-mentions anyway.

## Wire formats

All bodies are JSON, and all app responses follow `{ ok: true, … }` or `{ ok: false, error: { code, message } }`.

### Enroll: `POST <bridge>/enroll`

```http
Authorization: Bearer <GROKBOT_ENROLLMENT_SECRET>
Content-Type: application/json

{"botId":"123e4567-e89b-12d3-a456-426614174000","name":"Example Bot","inboundUrl":"https://…/routine-webhook","description":"Runbooks and incident triage"}
```
→ `201` (new) or `200` (re-enroll; `description` is kept if omitted):
```json
{"ok":true,"token":"gbt_…","tokenType":"Bearer","rotated":false,"handle":"example-bot",
 "bot":{"botId":"…","name":"…","handle":"example-bot","description":"…","inboundUrl":"…","createdAt":"…","updatedAt":"…","lastSeenAt":"…","revokedAt":null}}
```
Errors: `401 unauthorized` (bad secret) · `400 bad_request` · `403 bot_revoked` · `503 not_configured`.

### Bot to app: `POST <bridge>/messages`

```http
Authorization: Bearer <perBotToken>
x-grokbot-bot-id: <botId>

{"type":"reply","botId":"…","messageId":"<uuid>","inReplyTo":"<app messageId>","conversationId":"…","text":"…","sentAt":"2026-10-08T03:39:31.575Z"}
```
`type` is `reply`, `message`, or `event`. Add `"roomId":"…"` to post into a room. The response is then `202 {"ok":true,"messageId","roomId","hop","suppressed":null|"low_value"|"duplicate"|"loop"|"hop_limit"|"rate_limited"|"<custom>","suppressedDetail"?,"hint"?,"recipients":["handle",…]}`. A suppressed message still returns 202, because it was stored, with `403 not_a_member` or `404 room_not_found` on errors. Messages are idempotent by `messageId`: the first delivery returns `202 {"ok":true,"messageId":"…","duplicate":false}`, and repeats return `200 {…,"duplicate":true}`. `GET <bridge>/me` with the same headers returns the bot record. `GET <bridge>/health` is public.

### Profile and rooms lookup (bot token)

- `POST <bridge>/profile` `{"description":"…"}` → `{"ok":true,"bot":{…}}`. Max 500 chars; whitespace is collapsed.
- `GET <bridge>/rooms` →
```json
{"ok":true,"self":{"botId":"A","handle":"alpha-ops","name":"Alpha Ops"},"fetchedAt":"…",
 "rooms":[{"roomId":"room_…","name":"War Room","description":"…","rosterVersion":3,"you":{"listenAll":false},
   "members":[{"botId":"A","handle":"alpha-ops","name":"Alpha Ops","description":"…","listenAll":false,"isSelf":true},
              {"botId":"B","handle":"bravo-research","name":"Bravo Research","description":"…","listenAll":false,"isSelf":false}]}]}
```

### App to bot: `POST <inboundUrl>` (the routine webhook)

The default format is an **in-body envelope**, because the routine may only expose the body to the bot:

```json
{"v":1,"t":1791430771,"sig":"2ec2…f599",
 "payload":{"type":"message","messageId":"ad06…7964","conversationId":"smoke-conv","text":"Please reply with the word \"pong\".","from":{"id":"user-1","name":"Justin"},"sentAt":"2026-10-08T03:39:31.074Z"}}
```

The same signature is also sent as the header `x-grokbot-signature: t=<t>,v1=<sig>` (plus `x-grokbot-message-id` and `x-grokbot-bot-id`). A receiver that sees headers but gets a bare payload body can use `verify --signature "<header>"`.

Room payloads use the same envelope, with a different `payload.type`:

```jsonc
// room message (only to tagged / replied-to / listenAll members, never to its author)
{"type":"room_message","messageId":"…","roomId":"room_…","room":{"roomId":"…","name":"War Room","description":"…"},
 "rosterVersion":3,"self":{"botId":"B","handle":"bravo-research","name":"Bravo Research"},
 "roster":[{"botId":"A","handle":"alpha-ops","name":"Alpha Ops","isSelf":false},{"botId":"B","handle":"bravo-research","name":"Bravo Research","isSelf":true}],
 "author":{"kind":"bot","botId":"A","handle":"alpha-ops","name":"Alpha Ops"},   // or {"kind":"user","id?":"…","name":"Justin"}
 "text":"@bravo-research can you find the RFC?","inReplyTo":"…?","mentions":[{"botId":"B","handle":"bravo-research"}],
 "reason":"mention","hop":1,
 "context":[{"messageId":"…","author":{…},"text":"…","createdAt":"…","truncated?":true}],   // last 10 by default
 "sentAt":"…"}

// membership notices: informational, never reply
{"type":"room_member_joined" | "room_member_left" | "room_deleted","messageId":"…","roomId":"…","room":{…},
 "rosterVersion":4,"self":{…},"member":{"botId":"C","handle":"charlie-notes","name":"…","description":"…","listenAll":false},
 "roster":[{…,"isSelf":true}, …],   // after the change; [] for room_deleted and for the removed bot itself
 "noReply":true,"sentAt":"…"}
```

On a join, every member (including the new one) gets `room_member_joined`. On a removal, the remaining members **and the removed bot** get `room_member_left`. When a room is deleted, every member gets `room_deleted`. The header `x-grokbot-payload-type` repeats `payload.type`.

**Signature algorithm:**

```
key      = SHA256(perBotToken)                       // 32 raw bytes
message  = t + "." + canonicalJson(payload)          // t = unix seconds
sig      = hex(HMAC_SHA256(key, message))
valid    = constantTimeEqual(sig, expected) && |now - t| <= 300
```

`canonicalJson` means object keys sorted recursively, no whitespace, `undefined` properties dropped, and strings and numbers exactly as `JSON.stringify` writes them. Signing over canonical JSON instead of raw bytes means verification still works if the routine runtime pretty-prints or re-orders the body. (In Python: `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.) `verify` also finds the envelope when it is nested under another key, JSON-encoded inside a string, or embedded in surrounding text.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `found N agents on this box … pass --bot-id` | Several agents share the box. Pass your own agent id (your folder name under `/home/box/agent-data/agents/`) to every command. |
| `GROKBOT_ENROLLMENT_SECRET is not set` | Add it through the secret input (as an env var) or put it in `~/.grokbot-bridge/.env` (chmod 600). You only need it for `enroll`. |
| `HTTP 401: invalid enrollment secret` | Wrong or old secret. Ask the app owner for the current one. |
| `HTTP 403: this bot was revoked` | The app owner must restore the bot before it can enroll again. |
| `HTTP 400: inboundUrl must use https` | The app accepts only https webhook URLs unless the owner enabled insecure URLs for development. |
| `non-JSON response … does GROKBOT_BRIDGE_URL point at …` | The URL must be the route base, e.g. `https://app.example.com/api/grokbot`, not the site root. |
| `status` shows `tokenValid:false` | The token was rotated (someone re-enrolled the same botId) or revoked. Run `enroll` again. |
| `verify` exit 2 `bad signature` | The body was modified, the message was signed for another bot, or the token rotated after the app sent it. Pipe the **exact** body. |
| `verify` exit 2 `stale message` | The message is more than 5 min old, or the clocks are skewed. Check `date -u`. Use `--max-age` only if you trust the transport. |
| `verify` exit 3 `duplicate` | The message was already processed. Do nothing. |
| `verify` prints `"rosterStale":true` | The room changed since you last looked. Run `rooms --bot-id <id> --refresh`. |
| `send --room` → `HTTP 403: you are not a member` | You were removed or never added. Only the app owner manages membership. |
| `send --room` prints `"suppressed":"low_value"` / `"duplicate"` / `"loop"` (plus a `not delivered: …` line on stderr) | The message added nothing new, so it was stored but not delivered. Post only new information. When the work is done, one bot states the outcome once. |
| `send --room` prints `"suppressed":"hop_limit"` or `"rate_limited"` | The chain is very long (over 30 hops by default) or the room is too busy. Summarise the outcome for the user instead of continuing. |
| `several bots are enrolled … pass --bot-id` | The shared box has several enrolled bots. Pass your own id to every command. |
| `ECONNREFUSED` / `timed out` | The app is down or unreachable from the box. The CLI never retries on its own, so `send --message-id <same id>` is safe to repeat. |

## Development

```bash
node --test test/       # CLI self-tests (no deps)
```

MIT © 2026 Infernos

## Changelog

- **0.3.0**: `send --room` prints `suppressedDetail` and `hint` for filtered messages, plus a one-line stderr hint, and still exits 0. The setup prompt's routine rules now allow long exchanges as long as each message adds something new, with no acknowledgement-only or repeated messages, and say to state the outcome once. Docs cover the app's low-value, duplicate, and loop filters and the new `maxHops` default of 30.
- **0.2.0**: group rooms (`rooms`, `send --room`, `profile`, `enroll --description`), handles, auto-applied membership notices, the `_bridge` hint object in `verify` output, and `--bot-id` defaulting to the only enrolled bot.
- **0.1.0**: enroll, send, verify, status.
