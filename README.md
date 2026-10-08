# grokbot-bridge-plugin

Connect any **Grok Bot** to your web app with async messages that are authenticated in both directions.

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

The app is the only fixed address. Each bot tells the app where to reach it (its routine's webhook URL) when it enrolls.

## Quick start

1. The app owner sets `GROKBOT_ENROLLMENT_SECRET` in the app and mounts the bridge route.
2. Fill in the two placeholders in [`SETUP_PROMPT.md`](SETUP_PROMPT.md) and paste it into a Grok Bot.
3. The bot installs this script, receives the secret through its secure secret input, creates a webhook routine, runs `enroll`, and confirms with `status`.

Manual install (all the bot needs is Node 18+ and either git or curl):

```bash
git clone --depth 1 <PLUGIN_REPO_URL> ~/.grokbot-bridge/plugin
node ~/.grokbot-bridge/plugin/grokbot-bridge.mjs --help
```

## CLI

```
node grokbot-bridge.mjs enroll --inbound-url <url> [--bot-id <id>] [--name <name>] [--bridge-url <url>]
node grokbot-bridge.mjs send   [--text <text>] [--in-reply-to <id>] [--conversation-id <id>] [--type reply|message|event] [--message-id <id>]
node grokbot-bridge.mjs verify [--body <json> | --body-file <path>] [--signature "t=..,v1=.."] [--max-age <sec>] [--no-dedupe]
node grokbot-bridge.mjs status [--offline]
```

| Command | What it does |
|---|---|
| `enroll` | POSTs `{botId, name, inboundUrl}` to `<bridge>/enroll` with the enrollment secret, then saves the returned per-bot token. `botId` and `name` are auto-detected from `/home/box/agent-data/agents/*/profile.json`. If more than one agent exists on the box, you must pass `--bot-id`. Re-running it rotates the token. |
| `send` | Makes one authenticated POST to `<bridge>/messages`. Text comes from `--text` or stdin. `--in-reply-to` defaults `--type` to `reply`. A fresh `messageId` (UUID) is generated unless you pass `--message-id`, which makes the call safe to retry. |
| `verify` | Reads the webhook body from `--body`, `--body-file`, or stdin. It checks the HMAC and freshness (±300 s by default), then prints the payload JSON on stdout. It also remembers the last 500 messageIds per bot and refuses duplicates. |
| `status` | Shows the local enrollment (token redacted) and checks the token against `<bridge>/me`. |

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

**State.** `~/.grokbot-bridge/state.json` (dir `0700`, file `0600`, written atomically) holds `{ bots: { <botId>: { botId, name, token, inboundUrl, bridgeUrl, enrolledAt } }, seen: { <botId>: [messageId…] } }`. Several bots on one shared box each get their own entry. The state file never lives in a repo.

## Security model

- **Enrollment secret (shared, used once).** The app owner sets a single `GROKBOT_ENROLLMENT_SECRET`, and every bot gets the same value. A bot sends it only to `POST /enroll`. Rotating it in the app does **not** affect bots that are already enrolled, because they authenticate with their own tokens. The reference app accepts an array of secrets for overlap windows.
- **Per-bot token.** The app returns `gbt_` + 32 random bytes (base64url) and stores only `sha256(token)` (hex). Every later bot-to-app call sends `Authorization: Bearer <token>` plus `x-grokbot-bot-id`. Re-enrolling the same `botId` issues a new token and invalidates the old one. The app can revoke a single bot, and a revoked bot cannot re-enroll until the owner restores it.
- **Constant-time comparisons** are used for the enrollment secret, token hashes, and signatures.
- **App-to-bot signatures.** Every outbound message is signed with HMAC-SHA256. The **key is `sha256(token)`** as 32 raw bytes, not the token itself. The app never stores the raw token, so this is the strongest key both sides can derive. The consequence: anyone who can read the app's bot table could forge app-to-bot messages. They still could **not** impersonate a bot to the app, because that requires the token preimage. Re-enrolling rotates both values.
- **Replay protection.** The bot rejects timestamps more than 5 minutes from its clock in either direction, and refuses messageIds it has already seen.
- **Trust boundary.** A verified message proves it came from the app. It does not make the text safe. The setup prompt tells the bot to treat `payload.text` as a user request that never overrides its own rules and never reveals secrets.

## Wire formats

All bodies are JSON, and all app responses follow `{ ok: true, … }` or `{ ok: false, error: { code, message } }`.

### Enroll: `POST <bridge>/enroll`

```http
Authorization: Bearer <GROKBOT_ENROLLMENT_SECRET>
Content-Type: application/json

{"botId":"123e4567-e89b-12d3-a456-426614174000","name":"Example Bot","inboundUrl":"https://…/routine-webhook"}
```
→ `201` (new) or `200` (re-enroll):
```json
{"ok":true,"token":"gbt_…","tokenType":"Bearer","rotated":false,
 "bot":{"botId":"…","name":"…","inboundUrl":"…","createdAt":"…","updatedAt":"…","lastSeenAt":"…","revokedAt":null}}
```
Errors: `401 unauthorized` (bad secret) · `400 bad_request` · `403 bot_revoked` · `503 not_configured`.

### Bot to app: `POST <bridge>/messages`

```http
Authorization: Bearer <perBotToken>
x-grokbot-bot-id: <botId>

{"type":"reply","botId":"…","messageId":"<uuid>","inReplyTo":"<app messageId>","conversationId":"…","text":"…","sentAt":"2026-10-08T03:39:31.575Z"}
```
`type` is `reply`, `message`, or `event`. Messages are idempotent by `messageId`: the first delivery returns `202 {"ok":true,"messageId":"…","duplicate":false}`, and repeats return `200 {…,"duplicate":true}`. `GET <bridge>/me` with the same headers returns the bot record. `GET <bridge>/health` is public.

### App to bot: `POST <inboundUrl>` (the routine webhook)

The default format is an **in-body envelope**, because the routine may only expose the body to the bot:

```json
{"v":1,"t":1791430771,"sig":"2ec2…f599",
 "payload":{"type":"message","messageId":"ad06…7964","conversationId":"smoke-conv","text":"Please reply with the word \"pong\".","from":{"id":"user-1","name":"Justin"},"sentAt":"2026-10-08T03:39:31.074Z"}}
```

The same signature is also sent as the header `x-grokbot-signature: t=<t>,v1=<sig>` (plus `x-grokbot-message-id` and `x-grokbot-bot-id`). A receiver that sees headers but gets a bare payload body can use `verify --signature "<header>"`.

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
| `ECONNREFUSED` / `timed out` | The app is down or unreachable from the box. The CLI never retries on its own, so `send --message-id <same id>` is safe to repeat. |

## Development

```bash
node --test test/       # CLI self-tests (no deps)
```

MIT © 2026 Infernos
