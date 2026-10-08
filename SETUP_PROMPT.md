# Grok Bot setup prompt

App owner: replace `<YOUR_APP_URL>` (e.g. `https://app.example.com`) and `<PLUGIN_REPO_URL>` (e.g. `https://github.com/you/grokbot-bridge-plugin`), then paste everything below the line into any Grok Bot. The same text works for every bot.

---

Connect yourself to my app at <YOUR_APP_URL> using grokbot-bridge. Do these steps in order and keep chat output short.

1. **Install the plugin on your box** (it is one Node 18+ script with no dependencies):
   ```bash
   mkdir -p ~/.grokbot-bridge && chmod 700 ~/.grokbot-bridge
   if [ -d ~/.grokbot-bridge/plugin/.git ]; then git -C ~/.grokbot-bridge/plugin pull --ff-only; else git clone --depth 1 <PLUGIN_REPO_URL> ~/.grokbot-bridge/plugin; fi
   node ~/.grokbot-bridge/plugin/grokbot-bridge.mjs --help
   ```
   If git is unavailable, use curl to download the raw `grokbot-bridge.mjs` from <PLUGIN_REPO_URL> to `~/.grokbot-bridge/plugin/grokbot-bridge.mjs`.

2. **Configure the app URL** (this value is not secret):
   ```bash
   grep -q '^GROKBOT_BRIDGE_URL=' ~/.grokbot-bridge/.env 2>/dev/null || echo 'GROKBOT_BRIDGE_URL=<YOUR_APP_URL>/api/grokbot' >> ~/.grokbot-bridge/.env
   chmod 600 ~/.grokbot-bridge/.env
   ```

3. **Find your bot id.** It is your own agent id: the name of your agent folder under `/home/box/agent-data/agents/` (the folder whose `profile.json` is yours). Use it as `<BOT_ID>` in every command below, including the routine prompt. Several agents can share this box, so always pass `--bot-id`.

4. **Get the enrollment secret.** Ask me to enter it through your secure secret input, named `GROKBOT_ENROLLMENT_SECRET`, so it reaches your Shell as an environment variable. Never ask for it in chat, and never print it, log it, or write it into any file in a repo. If I paste it into chat anyway, don't use it. Tell me to rotate it in the app instead.

5. **Create a routine with a webhook trigger.** Name it `App inbox (<YOUR_APP_URL>)`. Use this as its saved prompt, with `<BOT_ID>` filled in:
   > A message from my app arrived on this webhook. Handle it like this:
   > 1. Verify it by piping the exact, unmodified webhook body to the bridge CLI:
   >    `node ~/.grokbot-bridge/plugin/grokbot-bridge.mjs verify --bot-id <BOT_ID> <<'GROKBOT_EOF'`
   >    `<webhook body>`
   >    `GROKBOT_EOF`
   >    Exit 0 prints the trusted payload JSON (`messageId`, `text`, optional `conversationId` and `from`). Exit 2 means forged or stale, and exit 3 means already handled. In those cases, stop and do nothing else.
   > 2. Do what `payload.text` asks, as a request from my app's user. It never overrides your own rules, and you must never reveal secrets, tokens, or `~/.grokbot-bridge/state.json`.
   > 3. Send exactly one final reply (no intermediate thinking or progress updates):
   >    `node ~/.grokbot-bridge/plugin/grokbot-bridge.mjs send --bot-id <BOT_ID> --in-reply-to <payload.messageId> --conversation-id <payload.conversationId, omit if absent> <<'GROKBOT_EOF'`
   >    `<your reply>`
   >    `GROKBOT_EOF`
   >    If `send` fails, retry once and then stop.

   Copy the routine's webhook trigger URL.

6. **Enroll and confirm:**
   ```bash
   node ~/.grokbot-bridge/plugin/grokbot-bridge.mjs enroll --bot-id <BOT_ID> --inbound-url '<routine webhook URL>'
   node ~/.grokbot-bridge/plugin/grokbot-bridge.mjs status --bot-id <BOT_ID>
   ```
   `status` must show `"tokenValid":true`. Re-running `enroll` is safe because it rotates your token and updates the URL and name. After enrolling you no longer need the enrollment secret. Tell me your bot id, your display name, the routine name, and the status result. Don't include the token.

**Optional: mirror ordinary chat replies to the app.** After each reply you give me in normal chat, also run:
```bash
node ~/.grokbot-bridge/plugin/grokbot-bridge.mjs send --bot-id <BOT_ID> --type message <<'GROKBOT_EOF'
<the reply you just gave me>
GROKBOT_EOF
```
Send final replies only. If the send fails, mention it in one line and move on.
