#!/usr/bin/env node
// grokbot-bridge — zero-dependency CLI that connects a Grok Bot to an app's
// /api/grokbot/* bridge route. Node 18+ built-ins only. MIT licensed.
//
//   node grokbot-bridge.mjs enroll  --inbound-url <url> [--description <text>] [--bot-id <id>] [--name <name>]
//   node grokbot-bridge.mjs send    --text <text> [--room <roomId>] [--in-reply-to <id>] [--conversation-id <id>]
//   node grokbot-bridge.mjs verify  [--body <json> | --body-file <path>]   (or stdin)
//   node grokbot-bridge.mjs rooms   [--refresh]
//   node grokbot-bridge.mjs profile --description <text>
//   node grokbot-bridge.mjs approval request|show|list|complete|fail|handoff ...
//   node grokbot-bridge.mjs soul pull|show|applied ...
//   node grokbot-bridge.mjs memory status|search|store|read ...
//   node grokbot-bridge.mjs status
//
// --bot-id defaults to the only bot enrolled in state.json.
// Exit codes: 0 ok, 1 usage/config/network error, 2 bad signature or stale
// message, 3 duplicate message (already processed).

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.5.0';
const HTTP_TIMEOUT_MS = Number(process.env.GROKBOT_BRIDGE_TIMEOUT_MS) || 10_000;
const HARD_DEADLINE_MS = HTTP_TIMEOUT_MS + 8_000;
const DEFAULT_MAX_AGE_SEC = 300;
const MAX_TEXT_CHARS = 100_000;
const MAX_DESCRIPTION_CHARS = 500;
const SEEN_PER_BOT = 500;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const APPROVAL_ID_RE = /^apr_[A-Za-z0-9_-]{8,64}$/;
const CODE_RE = /^gbe_[A-Za-z0-9_-]{20,200}$/;
const APPROVALS_PER_BOT = 50;
const CREATE_BOT_NAME_MAX = 60;
const CREATE_BOT_TEXT_MAX = 2000;
const CREATE_BOT_SOUL_MAX = 10_000;
const SOUL_VERSION_RE = /^[0-9a-f]{16,64}$/;
const MEMORY_KIND_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MEMORY_TEXT_MAX = 20_000;
const MEMORY_QUERY_MAX = 2000;

// Never hang: hard watchdog for the whole process.
const watchdog = setTimeout(() => fail(1, `timed out after ${HARD_DEADLINE_MS}ms`), HARD_DEADLINE_MS);
watchdog.unref();

class CliError extends Error {
  constructor(code, message, extra = {}) { super(message); this.exitCode = code; Object.assign(this, extra); }
}
function note(message) {
  // eslint-disable-next-line no-control-regex
  process.stderr.write(`grokbot-bridge: ${String(message).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()}\n`);
}
const SUPPRESS_HINTS = {
  low_value: 'not delivered: low_value (acknowledgement-only); only post new information',
  duplicate: 'not delivered: duplicate (repeats a recent message); only post new information',
  loop: 'not delivered: loop (ping-pong without new information); state the outcome once and stop',
  hop_limit: 'not delivered: hop_limit (bot-to-bot chain too long); summarise the outcome for the user instead',
  rate_limited: 'not delivered: rate_limited (too many bot messages in this room); slow down and only post new information',
};
function fail(code, message) {
  process.stderr.write(`grokbot-bridge: ${String(message).replace(/\s+/g, ' ').trim()}\n`);
  process.exit(code);
}

// ---------- args / env ----------
const BOOL_FLAGS = new Set(['no-dedupe', 'offline', 'help', 'json', 'refresh', 'remote', 'append']);
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq > -1 ? a.slice(2, eq) : a.slice(2);
    if (eq > -1) out[key] = a.slice(eq + 1);
    else if (BOOL_FLAGS.has(key)) out[key] = true;
    else {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('--') && v.length > 2)) throw new CliError(1, `--${key} needs a value`);
      out[key] = v; i++;
    }
  }
  return out;
}

function parseDotEnv(file) {
  const env = {};
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return env; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    env[m[1]] = v;
  }
  return env;
}

const HOME_DIR = process.env.GROKBOT_BRIDGE_HOME || join(homedir(), '.grokbot-bridge');
const STATE_FILE = join(HOME_DIR, 'state.json');
const AGENTS_DIR = process.env.GROKBOT_AGENTS_DIR || '/home/box/agent-data/agents';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Precedence: process env > ./.env (cwd) > <script dir>/.env > ~/.grokbot-bridge/.env
function getEnv(name) {
  if (process.env[name]) return process.env[name];
  for (const f of [join(process.cwd(), '.env'), join(SCRIPT_DIR, '.env'), join(HOME_DIR, '.env')]) {
    const v = parseDotEnv(f)[name];
    if (v) return v;
  }
  return undefined;
}

// ---------- state ----------
function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (s && typeof s === 'object' && s.bots && typeof s.bots === 'object') return { version: 1, seen: {}, ...s };
  } catch (e) {
    if (e.code !== 'ENOENT') throw new CliError(1, `cannot read ${STATE_FILE}: ${e.message}`);
  }
  return { version: 1, bots: {}, seen: {} };
}
function writeSecureJson(file, data) {
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(HOME_DIR, 0o700); } catch {}
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
function saveState(state) { writeSecureJson(STATE_FILE, state); }

// Per-bot rooms cache: the box is shared by several agents.
function roomsFile(botId) { return join(HOME_DIR, `rooms.${botId}.json`); }
function loadRooms(botId) {
  try {
    const c = JSON.parse(readFileSync(roomsFile(botId), 'utf8'));
    if (c && Array.isArray(c.rooms)) return c;
  } catch (e) {
    if (e.code !== 'ENOENT') throw new CliError(1, `cannot read ${roomsFile(botId)}: ${e.message}`);
  }
  return null;
}
function saveRooms(botId, cache) { writeSecureJson(roomsFile(botId), cache); }
function selectBot(state, args) {
  const want = args['bot-id'] || process.env.GROKBOT_BOT_ID;
  const ids = Object.keys(state.bots);
  if (want) {
    if (!state.bots[want]) throw new CliError(1, `bot ${want} is not enrolled on this box (run enroll first)`);
    return state.bots[want];
  }
  if (ids.length === 1) return state.bots[ids[0]];
  if (ids.length === 0) throw new CliError(1, 'not enrolled yet: run `enroll --inbound-url <routine webhook url>` first');
  throw new CliError(1, `several bots are enrolled on this box (${ids.join(', ')}); pass --bot-id <your agent id>`);
}

// ---------- identity ----------
function listAgents() {
  let entries = [];
  try { entries = readdirSync(AGENTS_DIR, { withFileTypes: true }); } catch { return []; }
  const agents = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(AGENTS_DIR, e.name, 'profile.json');
    if (!existsSync(p)) continue;
    let name;
    try { name = JSON.parse(readFileSync(p, 'utf8')).name; } catch {}
    agents.push({ id: e.name, name: typeof name === 'string' && name.trim() ? name.trim() : undefined });
  }
  return agents;
}
function resolveIdentity(args) {
  const agents = listAgents();
  let botId = args['bot-id'] || process.env.GROKBOT_BOT_ID;
  if (!botId) {
    if (agents.length === 1) botId = agents[0].id;
    else if (agents.length === 0) throw new CliError(1, `no agent profile found in ${AGENTS_DIR}; pass --bot-id <id>`);
    else throw new CliError(1, `found ${agents.length} agents on this box (${agents.map((a) => `${a.id}${a.name ? ` "${a.name}"` : ''}`).join(', ')}); pass --bot-id <your agent id>`);
  }
  if (!ID_RE.test(botId)) throw new CliError(1, `invalid bot id: ${botId}`);
  const name = args.name || agents.find((a) => a.id === botId)?.name || botId;
  return { botId, name: String(name).slice(0, 100) };
}

// ---------- crypto (must match @infernos/grokbot-bridge-next) ----------
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}
// HMAC key = SHA-256(perBotToken) as 32 raw bytes (the app stores this as hex).
function signingKey(token) { return createHash('sha256').update(token, 'utf8').digest(); }
function sign(token, t, payload) {
  return createHmac('sha256', signingKey(token)).update(`${t}.${canonicalJson(payload)}`, 'utf8').digest('hex');
}
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[0-9a-f]+$/i.test(a)) return false;
  const ba = Buffer.from(a.toLowerCase(), 'utf8');
  const bb = Buffer.from(b.toLowerCase(), 'utf8');
  if (ba.length !== bb.length) { timingSafeEqual(bb, bb); return false; }
  return timingSafeEqual(ba, bb);
}

// Find {v,t,sig,payload} anywhere in what the routine handed us: raw JSON,
// JSON nested under another key, JSON-in-a-string, or JSON embedded in text.
function isEnvelope(o) { return o && typeof o === 'object' && !Array.isArray(o) && 'sig' in o && 't' in o && 'payload' in o; }
function findEnvelope(value, depth = 0) {
  if (depth > 6 || value == null) return undefined;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.startsWith('{') || s.startsWith('[') || s.startsWith('"')) {
      try { return findEnvelope(JSON.parse(s), depth + 1); } catch {}
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  if (isEnvelope(value)) return value;
  for (const v of Object.values(value)) { const f = findEnvelope(v, depth + 1); if (f) return f; }
  return undefined;
}
function extractJsonObjects(text) {
  const found = [];
  for (let start = text.indexOf('{'); start !== -1 && found.length < 20; start = text.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { found.push(JSON.parse(text.slice(start, i + 1))); } catch {}
        break;
      }
    }
  }
  return found;
}
function parseSigHeader(h) {
  const out = {};
  for (const part of String(h).split(',')) { const [k, ...r] = part.trim().split('='); out[k] = r.join('='); }
  return { t: Number(out.t), sig: out.v1 };
}

// ---------- io ----------
function readStdin({ firstByteMs = 1500, totalMs = 5000 } = {}) {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const chunks = [];
    let got = false;
    const done = () => { clearTimeout(t1); clearTimeout(t2); process.stdin.pause(); process.stdin.removeAllListeners(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const t1 = setTimeout(() => { if (!got) done(); }, firstByteMs);
    const t2 = setTimeout(done, totalMs);
    process.stdin.on('data', (c) => { got = true; chunks.push(c); });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function http(method, url, { headers = {}, body, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'user-agent': `grokbot-bridge-cli/${VERSION}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : (e?.cause?.code || e?.cause?.message || e?.message);
    throw new CliError(1, `${method} ${url} failed: ${why}`);
  }
  const text = await res.text().catch(() => '');
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = undefined; }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error?.code
      || (json === undefined ? `non-JSON response (${(res.headers.get('content-type') || 'unknown type').split(';')[0]}); does GROKBOT_BRIDGE_URL point at the app's /api/grokbot route?` : '')
      || res.statusText;
    throw new CliError(1, `${method} ${url} -> HTTP ${res.status}: ${msg}`, { httpStatus: res.status, errorCode: json?.error?.code });
  }
  if (json === undefined) throw new CliError(1, `${method} ${url} returned non-JSON`);
  return json;
}

function bridgeUrlFrom(args, bot) {
  const raw = args['bridge-url'] || bot?.bridgeUrl || getEnv('GROKBOT_BRIDGE_URL');
  if (!raw) throw new CliError(1, 'GROKBOT_BRIDGE_URL is not set (env, .env, or --bridge-url)');
  let u;
  try { u = new URL(raw); } catch { throw new CliError(1, `GROKBOT_BRIDGE_URL is not a valid URL: ${raw}`); }
  if (!/^https?:$/.test(u.protocol)) throw new CliError(1, 'GROKBOT_BRIDGE_URL must be http(s)');
  return u.toString().replace(/\/+$/, '');
}

// ---------- commands ----------
async function cmdEnroll(args) {
  const inboundUrl = args['inbound-url'];
  if (!inboundUrl) throw new CliError(1, 'enroll needs --inbound-url <your routine webhook URL>');
  try { new URL(inboundUrl); } catch { throw new CliError(1, `--inbound-url is not a valid URL: ${inboundUrl}`); }
  // A one-time enrollment code (from an approved create_bot handoff) replaces the shared secret.
  const code = args['enrollment-code'] || process.env.GROKBOT_ENROLLMENT_CODE;
  if (code !== undefined && code !== '' && !CODE_RE.test(code)) throw new CliError(1, 'enrollment code must look like gbe_... (copy it exactly from the handoff)');
  const secret = code || getEnv('GROKBOT_ENROLLMENT_SECRET');
  if (!secret) throw new CliError(1, 'GROKBOT_ENROLLMENT_SECRET is not set (add it via your secret input or ~/.grokbot-bridge/.env), and no --enrollment-code was given');
  const { botId, name } = resolveIdentity(args);
  const description = args.description ?? process.env.GROKBOT_BOT_DESCRIPTION;
  if (description !== undefined && description.length > MAX_DESCRIPTION_CHARS) throw new CliError(1, `--description too long (max ${MAX_DESCRIPTION_CHARS} chars)`);
  const bridgeUrl = bridgeUrlFrom(args);
  let res;
  try {
    res = await http('POST', `${bridgeUrl}/enroll`, {
      headers: { authorization: `Bearer ${secret}` },
      body: { botId, name, inboundUrl, ...(description !== undefined ? { description } : {}) },
    });
  } catch (e) {
    if (code && e instanceof CliError && e.httpStatus === 401) {
      throw new CliError(1, 'enrollment code is invalid, already used, or expired; it cannot be reused. Ask your creator bot or the app owner to have the app re-send the approval (a new code)', e);
    }
    throw e;
  }
  if (typeof res.token !== 'string' || res.token.length < 20) throw new CliError(1, 'enroll response did not include a token');
  const state = loadState();
  const prev = state.bots[botId];
  state.bots[botId] = {
    ...(prev?.approvals ? { approvals: prev.approvals } : {}),
    ...(prev?.soul ? { soul: prev.soul } : {}),
    ...(res.memorySource ? { memorySource: res.memorySource } : prev?.memorySource ? { memorySource: prev.memorySource } : {}),
    botId, name: res.bot?.name || name, handle: res.handle || res.bot?.handle, description: res.bot?.description ?? description ?? '',
    token: res.token, inboundUrl: res.bot?.inboundUrl || inboundUrl, bridgeUrl, enrolledAt: res.bot?.updatedAt || new Date().toISOString(),
  };
  saveState(state);
  const b = state.bots[botId];
  // v0.5: the app may hold a soul (persona) for this bot. Fetch it now so the bot can adopt it right away.
  let soul;
  if (res.soul && typeof res.soul === 'object') {
    try {
      const pulled = await pullSoul(state, b, args);
      soul = summariseSoul(pulled, botId);
    } catch (e) {
      soul = { version: res.soul.version ?? null, error: e.message, next: `run: ${CLI_CMD} soul pull --bot-id ${botId}` };
    }
  } else if ('soul' in res) {
    soul = null;
  }
  out({
    ok: true, botId, name: b.name, handle: b.handle ? `@${b.handle}` : null, description: b.description, inboundUrl: b.inboundUrl, bridgeUrl, rotated: !!res.rotated,
    ...(code ? { enrolledWith: 'enrollment_code', createdByBotId: res.bot?.createdByBotId ?? null, approvalId: res.bot?.approvalId ?? null } : {}),
    ...(soul !== undefined ? { soul } : {}),
    ...(res.memorySource ? { memorySource: res.memorySource, memoryNext: memoryNext(res.memorySource, botId) } : {}),
    stateFile: STATE_FILE,
  });
}

async function cmdSend(args) {
  const state = loadState();
  const bot = selectBot(state, args);
  let text = args.text;
  if (text === undefined) text = (await readStdin()).replace(/\r?\n$/, '');
  if (!text || !text.trim()) throw new CliError(1, 'send needs --text <text> or text on stdin');
  if (text.length > MAX_TEXT_CHARS) throw new CliError(1, `text too long (${text.length} > ${MAX_TEXT_CHARS} chars)`);
  const type = args.type || (args['in-reply-to'] ? 'reply' : 'message');
  if (!['reply', 'message', 'event'].includes(type)) throw new CliError(1, '--type must be reply, message or event');
  for (const k of ['in-reply-to', 'conversation-id', 'message-id', 'room']) {
    if (args[k] !== undefined && !ID_RE.test(args[k])) throw new CliError(1, `invalid --${k}: ${args[k]}`);
  }
  const body = {
    type, botId: bot.botId, messageId: args['message-id'] || randomUUID(),
    inReplyTo: args['in-reply-to'], conversationId: args['conversation-id'], roomId: args.room,
    text, sentAt: new Date().toISOString(),
  };
  const res = await http('POST', `${bridgeUrlFrom(args, bot)}/messages`, {
    headers: { authorization: `Bearer ${bot.token}`, 'x-grokbot-bot-id': bot.botId },
    body,
  });
  if (args.room) {
    const suppressed = typeof res.suppressed === 'string' ? res.suppressed : null;
    const hint = suppressed ? (typeof res.hint === 'string' && res.hint) || SUPPRESS_HINTS[suppressed] || `not delivered: ${suppressed}` : undefined;
    out({
      ok: true, messageId: res.messageId || body.messageId, roomId: args.room, duplicate: !!res.duplicate, hop: res.hop,
      suppressed,
      ...(suppressed && res.suppressedDetail ? { suppressedDetail: String(res.suppressedDetail) } : {}),
      ...(hint ? { hint } : {}),
      deliveredTo: (res.recipients || []).map((h) => `@${h}`),
    });
    if (hint) note(hint); // exit 0: the app accepted and stored it, it just did not wake anyone
  } else {
    out({ ok: true, messageId: res.messageId || body.messageId, duplicate: !!res.duplicate });
  }
}

async function cmdVerify(args) {
  let raw = args.body;
  if (raw === undefined && args['body-file']) {
    try { raw = readFileSync(args['body-file'], 'utf8'); } catch (e) { throw new CliError(1, `cannot read --body-file: ${e.message}`); }
  }
  if (raw === undefined) raw = await readStdin();
  if (!raw || !raw.trim()) throw new CliError(1, 'verify needs the webhook body via --body, --body-file or stdin');

  let env = findEnvelope(raw);
  if (!env) for (const o of extractJsonObjects(raw)) { env = findEnvelope(o); if (env) break; }
  let t, sig, payload;
  if (env) {
    if (env.v !== undefined && env.v !== 1) throw new CliError(2, `unsupported envelope version ${env.v}`);
    ({ t, sig, payload } = env);
  } else if (args.signature) {
    // Header mode: body is the bare payload, signature came from x-grokbot-signature.
    ({ t, sig } = parseSigHeader(args.signature));
    try { payload = JSON.parse(raw); } catch { throw new CliError(2, 'body is not JSON'); }
  } else {
    throw new CliError(2, 'no signed envelope ({v,t,sig,payload}) found in body');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new CliError(2, 'payload must be an object');
  t = Number(t);
  if (!Number.isInteger(t)) throw new CliError(2, 'missing or invalid timestamp');

  const state = loadState();
  const bot = selectBot(state, args);
  if (!safeEqualHex(String(sig || ''), sign(bot.token, t, payload))) throw new CliError(2, 'bad signature (wrong bot, rotated token, or tampered body)');
  const maxAge = Number(args['max-age']) || DEFAULT_MAX_AGE_SEC;
  const skew = Math.floor(Date.now() / 1000) - t;
  if (Math.abs(skew) > maxAge) throw new CliError(2, `stale message: timestamp is ${skew}s off (limit ${maxAge}s); possible replay`);

  const isAction = ACTION_TYPES.has(payload.type);
  if (isAction) checkActionPayload(payload); // exit 2 on a params/paramsHash mismatch

  const id = payload.messageId;
  let dirty = false;
  if (!args['no-dedupe'] && typeof id === 'string') {
    const seen = (state.seen[bot.botId] ||= []);
    if (seen.includes(id)) throw new CliError(3, `duplicate message ${id} (already processed)`);
    seen.push(id);
    if (seen.length > SEEN_PER_BOT) seen.splice(0, seen.length - SEEN_PER_BOT);
    dirty = true;
  }
  if (isAction) { storeAction(state.bots[bot.botId], payload); dirty = true; }
  if (payload.type === 'memory_source_updated' && payload.memorySource && typeof payload.memorySource === 'object') {
    state.bots[bot.botId].memorySource = { kind: String(payload.memorySource.kind || 'none'), sharedRead: payload.memorySource.sharedRead === true };
    dirty = true;
  }
  if (dirty) saveState(state);
  const shown = isAction && payload.enrollmentCode ? { ...payload, enrollmentCode: redactCode(payload.enrollmentCode) } : payload;
  const _bridge = classify(bot.botId, payload, state.bots[bot.botId]);
  process.stdout.write(JSON.stringify({ ...shown, _bridge }) + '\n');
}

const NOTICE_TYPES = new Set(['room_member_joined', 'room_member_left', 'room_deleted']);
const ACTION_TYPES = new Set(['approval_decision', 'action_request']);
const CONFIG_TYPES = new Set(['soul_updated', 'memory_source_updated']);
const CLI_CMD = 'node ~/.grokbot-bridge/plugin/grokbot-bridge.mjs';

// Tell the routine what to do with a verified payload, and keep the rooms cache in sync.
function classify(botId, p, bot) {
  if (CONFIG_TYPES.has(p.type)) return classifyConfig(botId, p, bot);
  const base = classifyTask(botId, p);
  // v0.5: task envelopes carry the bot's current soulVersion; compare with the version this bot last applied.
  if (p.soulVersion !== undefined && base.kind !== 'notice') {
    const applied = appliedSoulVersion(bot);
    if ((p.soulVersion ?? null) !== applied) {
      base.soul = {
        stale: true, version: p.soulVersion ?? null, applied,
        next: `before acting: run ${CLI_CMD} soul pull --bot-id ${botId}, adopt the result as your persona (rule 8), run its appliedWith command, then handle this message`,
      };
    }
  }
  return base;
}

function classifyConfig(botId, p, bot) {
  const base = { kind: 'config', noReply: true, reply: 'none' };
  if (p.type === 'soul_updated') {
    const applied = appliedSoulVersion(bot);
    const version = p.soulVersion ?? null;
    return {
      ...base, change: 'soul', version, applied, soulStale: version !== applied, updatedBy: p.updatedBy ?? null,
      next: version === applied
        ? 'your soul is already up to date: do nothing, stop silently'
        : `my owner changed your soul in my app: run ${CLI_CMD} soul pull --bot-id ${botId}, adopt it as your persona (rule 8), run its appliedWith command; do not reply`,
    };
  }
  const src = { kind: String(p.memorySource?.kind || 'none'), sharedRead: p.memorySource?.sharedRead === true };
  return { ...base, change: 'memory_source', memorySource: src, next: memoryNext(src, botId) + '; do not reply' };
}

function classifyTask(botId, p) {
  if (NOTICE_TYPES.has(p.type)) {
    const applied = applyNotice(botId, p);
    return { kind: 'notice', noReply: true, reply: 'none', ...applied, cacheFile: roomsFile(botId), note: 'membership notice applied to the local rooms cache; do not reply' };
  }
  if (p.type === 'room_message') {
    const cached = loadRooms(botId)?.rooms.find((r) => r.roomId === p.roomId);
    const cachedRosterVersion = cached ? cached.rosterVersion : null;
    const rosterStale = cachedRosterVersion === null || cachedRosterVersion < p.rosterVersion;
    return {
      kind: 'room', noReply: false, reply: 'optional', reason: p.reason,
      rosterStale, cachedRosterVersion, rosterVersion: p.rosterVersion,
      ...(rosterStale ? { hint: `run: ${CLI_CMD} rooms --bot-id ${botId} --refresh` } : {}),
      replyWith: `${CLI_CMD} send --bot-id ${botId} --room ${p.roomId} --in-reply-to ${p.messageId}`,
    };
  }
  if (ACTION_TYPES.has(p.type)) return classifyAction(botId, p);
  return { kind: 'direct', noReply: false, reply: 'required', replyWith: `${CLI_CMD} send --bot-id ${botId} --in-reply-to ${p.messageId}` };
}

function applyNotice(botId, p) {
  if (typeof p.roomId !== 'string' || !Number.isInteger(p.rosterVersion)) return { cacheUpdated: false, reason: 'malformed notice' };
  const cache = loadRooms(botId) || { botId, self: p.self, fetchedAt: null, rooms: [] };
  const idx = cache.rooms.findIndex((r) => r.roomId === p.roomId);
  const cur = idx >= 0 ? cache.rooms[idx] : null;
  if (cur && cur.rosterVersion > p.rosterVersion) return { cacheUpdated: false, reason: 'notice is older than the cache' };
  const leftMe = p.type === 'room_member_left' && p.member?.botId === botId;
  if (p.type === 'room_deleted' || leftMe) {
    if (idx >= 0) cache.rooms.splice(idx, 1);
  } else {
    const roster = Array.isArray(p.roster) ? p.roster : [];
    const me = roster.find((m) => m.botId === botId);
    const view = { ...p.room, roomId: p.roomId, rosterVersion: p.rosterVersion, you: { listenAll: !!me?.listenAll }, members: roster };
    if (idx >= 0) cache.rooms[idx] = view; else cache.rooms.push(view);
  }
  if (p.self) cache.self = p.self;
  cache.updatedAt = new Date().toISOString();
  saveRooms(botId, cache);
  return { cacheUpdated: true, roomRemoved: p.type === 'room_deleted' || leftMe };
}

// ---------- approvals ----------
function redactCode(c) { return typeof c === 'string' && c ? `${c.slice(0, 4)}…(redacted, ${c.length} chars)` : c; }
function hashParams(params) { return createHash('sha256').update(canonicalJson(params), 'utf8').digest('hex'); }
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function checkActionPayload(p) {
  if (typeof p.approvalId !== 'string' || !APPROVAL_ID_RE.test(p.approvalId)) throw new CliError(2, 'action payload has no valid approvalId');
  if (!p.params || typeof p.params !== 'object' || Array.isArray(p.params)) throw new CliError(2, 'action payload has no params object');
  if (typeof p.paramsHash !== 'string' || !safeEqualHex(p.paramsHash, hashParams(p.params))) {
    throw new CliError(2, 'paramsHash does not match params (tampered or corrupted action); do not act on it');
  }
  if (!['approved', 'denied', 'expired'].includes(p.status)) throw new CliError(2, `unknown action status ${String(p.status).slice(0, 20)}`);
  if (p.enrollmentCode !== undefined && (typeof p.enrollmentCode !== 'string' || !CODE_RE.test(p.enrollmentCode))) throw new CliError(2, 'malformed enrollment code in action payload');
}

function storeAction(bot, p) {
  const list = (bot.approvals ||= {});
  const prev = list[p.approvalId] || {};
  list[p.approvalId] = {
    ...prev,
    approvalId: p.approvalId, kind: p.kind, origin: p.type === 'action_request' ? 'app' : 'self', status: p.status,
    params: p.params, paramsHash: p.paramsHash,
    ...(p.note ? { note: p.note } : {}), ...(p.reason ? { reason: p.reason } : {}),
    decidedBy: p.decidedBy ?? null, decidedAt: p.decidedAt ?? null, expiresAt: p.expiresAt ?? null,
    ...(p.enrollmentCode ? { enrollmentCode: p.enrollmentCode, enrollmentCodeExpiresAt: p.enrollmentCodeExpiresAt ?? null } : {}),
    receivedAt: new Date().toISOString(),
  };
  if (p.status !== 'approved') delete list[p.approvalId].enrollmentCode;
  const ids = Object.keys(list);
  if (ids.length > APPROVALS_PER_BOT) {
    ids.sort((a, b) => String(list[a].receivedAt || list[a].requestedAt || '').localeCompare(String(list[b].receivedAt || list[b].requestedAt || '')));
    for (const old of ids.slice(0, ids.length - APPROVALS_PER_BOT)) delete list[old];
  }
}

function classifyAction(botId, p) {
  const action = { approvalId: p.approvalId, kind: p.kind, status: p.status, params: p.params };
  const base = { kind: 'action', noReply: true, reply: 'none', action, origin: p.type === 'action_request' ? 'app' : 'your_request' };
  const id = p.approvalId;
  if (p.status !== 'approved') return { ...base, next: `approval ${p.status}: do nothing, stop silently` };
  const complete = `${CLI_CMD} approval complete --bot-id ${botId} --id ${id} --result '<json>'`;
  const failWith = `${CLI_CMD} approval fail --bot-id ${botId} --id ${id} --error '<one line>'`;
  if (p.kind === 'create_bot') {
    return {
      ...base,
      next: 'create a new teammate bot with EXACTLY params.name and params.description; message it the output of handoffWith; then run completeWith (or failWith if creation failed)',
      ...(p.enrollmentCode ? { enrollmentCode: redactCode(p.enrollmentCode), enrollmentCodeExpiresAt: p.enrollmentCodeExpiresAt ?? null } : {}),
      handoffWith: `${CLI_CMD} approval handoff --bot-id ${botId} --id ${id}`,
      completeWith: `${CLI_CMD} approval complete --bot-id ${botId} --id ${id} --result '{"createdBotId":"<new bot id>","createdBotName":"<name>"}'`,
      failWith,
    };
  }
  return { ...base, next: `approved ${p.kind}: perform it only if you know how; then run completeWith (or failWith)`, completeWith: complete, failWith };
}

function redactApproval(a) {
  if (!a) return a;
  const { enrollmentCode, ...rest } = a;
  return { ...rest, ...(enrollmentCode ? { enrollmentCode: redactCode(enrollmentCode) } : {}) };
}

function approvalIdArg(args) {
  const id = args.id || args['approval-id'];
  if (!id || !APPROVAL_ID_RE.test(id)) throw new CliError(1, 'needs --id <approvalId> (apr_...)');
  return id;
}

function botHeaders(bot) { return { authorization: `Bearer ${bot.token}`, 'x-grokbot-bot-id': bot.botId }; }

function parseJsonArg(raw, flag) {
  let v;
  try { v = JSON.parse(raw); } catch { throw new CliError(1, `--${flag} must be JSON`); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CliError(1, `--${flag} must be a JSON object`);
  return v;
}

async function approvalRequest(args, state, bot) {
  const kind = args.kind || 'create_bot';
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(kind)) throw new CliError(1, 'invalid --kind');
  let params;
  if (args.params !== undefined) params = parseJsonArg(args.params, 'params');
  else if (kind === 'create_bot') {
    const name = String(args.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw new CliError(1, 'approval request --kind create_bot needs --name <name> (and --description <text>)');
    if (name.length > CREATE_BOT_NAME_MAX) throw new CliError(1, `--name too long (max ${CREATE_BOT_NAME_MAX} chars)`);
    const description = String(args.description ?? '');
    if (description.length > CREATE_BOT_TEXT_MAX) throw new CliError(1, `--description too long (max ${CREATE_BOT_TEXT_MAX} chars)`);
    if (args.purpose !== undefined && String(args.purpose).length > CREATE_BOT_TEXT_MAX) throw new CliError(1, `--purpose too long (max ${CREATE_BOT_TEXT_MAX} chars)`);
    let soul = args.soul;
    if (soul === undefined && args['soul-file']) {
      try { soul = readFileSync(args['soul-file'], 'utf8'); } catch (e) { throw new CliError(1, `cannot read --soul-file: ${e.message}`); }
    }
    if (soul !== undefined) {
      soul = String(soul).replace(/\r\n?/g, '\n').trim();
      if (soul.length > CREATE_BOT_SOUL_MAX) throw new CliError(1, `--soul too long (max ${CREATE_BOT_SOUL_MAX} chars)`);
    }
    params = { name, description, ...(args.purpose ? { purpose: String(args.purpose) } : {}), ...(soul ? { soul } : {}) };
  } else throw new CliError(1, `approval request --kind ${kind} needs --params '<json object>'`);
  const requestId = args['request-id'] || randomUUID();
  if (!ID_RE.test(requestId)) throw new CliError(1, 'invalid --request-id');
  const res = await http('POST', `${bridgeUrlFrom(args, bot)}/approvals`, {
    headers: botHeaders(bot),
    body: { botId: bot.botId, kind, params, ...(args.reason ? { reason: String(args.reason) } : {}), requestId },
  });
  if (typeof res.approvalId !== 'string' || !APPROVAL_ID_RE.test(res.approvalId)) throw new CliError(1, 'approval response did not include an approvalId');
  const list = (state.bots[bot.botId].approvals ||= {});
  const requestedAt = list[res.approvalId]?.requestedAt || new Date().toISOString();
  list[res.approvalId] = { ...(list[res.approvalId] || {}), approvalId: res.approvalId, kind, origin: 'self', status: res.status || 'pending', params, paramsHash: res.paramsHash ?? hashParams(params), requestedAt, expiresAt: res.expiresAt ?? null };
  // App policy decided on the spot (create-bots policy "auto" or the app's approvalPolicy hook):
  // the decision (with the one-time code when approved) comes back in this response, not on the webhook.
  const d = res.decision;
  const sync = !!(d && typeof d === 'object' && d.approvalId === res.approvalId && (d.status === 'approved' || d.status === 'denied'));
  if (sync) {
    checkActionPayload(d); // same paramsHash check as verify
    if (d.paramsHash !== hashParams(params)) throw new CliError(2, 'the app decided on different params than requested; do not act on it');
    storeAction(state.bots[bot.botId], d);
    list[res.approvalId].requestedAt = requestedAt;
  }
  saveState(state);
  const auto = sync && d.status === 'approved';
  const extra = sync && !auto
    ? { decidedBy: d.decidedBy ?? null, ...(d.reason ? { reason: d.reason } : {}), next: 'denied by the app: do not create it; tell the requester it was not approved' }
    : auto
    ? {
        autoApproved: true, decidedBy: d.decidedBy ?? null,
        ...(d.enrollmentCode ? { enrollmentCode: redactCode(d.enrollmentCode), enrollmentCodeExpiresAt: d.enrollmentCodeExpiresAt ?? null } : {}),
        next: kind === 'create_bot'
          ? 'approved now: create the bot with EXACTLY these params, send it the output of handoffWith, then run completeWith'
          : 'approved now: perform it, then run completeWith',
        ...(kind === 'create_bot' ? { handoffWith: `${CLI_CMD} approval handoff --bot-id ${bot.botId} --id ${res.approvalId}` } : {}),
        completeWith: `${CLI_CMD} approval complete --bot-id ${bot.botId} --id ${res.approvalId} --result '<json>'`,
      }
    : { hint: 'tell the requester it is awaiting approval in the app; the decision arrives on your webhook' };
  out({ ok: true, approvalId: res.approvalId, status: sync ? d.status : res.status || 'pending', kind, params, expiresAt: res.expiresAt ?? null, ...(res.duplicate ? { duplicate: true } : {}), ...extra });
}

async function approvalFinish(args, state, bot, outcome) {
  const id = approvalIdArg(args);
  let body;
  if (outcome === 'complete') body = { botId: bot.botId, result: args.result === undefined ? {} : parseJsonArg(args.result, 'result') };
  else {
    const error = String(args.error ?? '').trim();
    if (!error) throw new CliError(1, "approval fail needs --error '<one line>'");
    body = { botId: bot.botId, error: error.slice(0, 2000) };
  }
  const list = (state.bots[bot.botId].approvals ||= {});
  let res;
  try {
    res = await http('POST', `${bridgeUrlFrom(args, bot)}/approvals/${encodeURIComponent(id)}/${outcome}`, { headers: botHeaders(bot), body });
  } catch (e) {
    if (e instanceof CliError && e.errorCode === 'already_completed') {
      if (list[id]) { list[id].status = /failed/.test(e.message) ? 'failed' : 'completed'; delete list[id].enrollmentCode; saveState(state); }
      note('already finished on the app side; nothing more to do');
      return out({ ok: true, approvalId: id, alreadyFinished: true, message: e.message.replace(/^.*HTTP 409: /, '') });
    }
    throw e;
  }
  if (list[id]) {
    list[id].status = res.approval?.status || (outcome === 'complete' ? 'completed' : 'failed');
    list[id].completedAt = res.approval?.completedAt || new Date().toISOString();
    delete list[id].enrollmentCode; // no longer needed by us; the new bot already has it (or the action failed)
    saveState(state);
  }
  out({ ok: true, approvalId: id, status: res.approval?.status || (outcome === 'complete' ? 'completed' : 'failed') });
}

async function approvalShow(args, state, bot) {
  const id = approvalIdArg(args);
  const local = state.bots[bot.botId].approvals?.[id];
  if (local && !args.remote) return out({ ok: true, source: 'local', approval: redactApproval(local) });
  const res = await http('GET', `${bridgeUrlFrom(args, bot)}/approvals/${encodeURIComponent(id)}`, { headers: botHeaders(bot) });
  if (local && res.approval?.status) { local.status = res.approval.status; if (!['approved'].includes(local.status)) delete local.enrollmentCode; saveState(state); }
  out({ ok: true, source: 'app', approval: res.approval, ...(local ? { local: redactApproval(local) } : {}) });
}

function readSetupPrompt() {
  try {
    const text = readFileSync(join(SCRIPT_DIR, 'SETUP_PROMPT.md'), 'utf8');
    const i = text.indexOf('\n---\n');
    return i >= 0 ? text.slice(i + 5).trim() : null;
  } catch { return null; }
}

function approvalHandoff(args, state, bot) {
  const id = approvalIdArg(args);
  const a = state.bots[bot.botId].approvals?.[id];
  if (!a) throw new CliError(1, `approval ${id} is not stored for bot ${bot.botId}; it arrives with a verified approval_decision/action_request`);
  if (a.kind !== 'create_bot') throw new CliError(1, `approval ${id} is ${a.kind}, not create_bot`);
  if (a.status !== 'approved') throw new CliError(1, `approval ${id} is ${a.status}; nothing to hand off`);
  if (!a.enrollmentCode) throw new CliError(1, `no enrollment code stored for ${id} (already completed or handed off?)`);
  if (a.enrollmentCodeExpiresAt && Date.parse(a.enrollmentCodeExpiresAt) <= Date.now()) {
    throw new CliError(1, `the enrollment code for ${id} expired at ${a.enrollmentCodeExpiresAt}; ask the app owner to re-send the approval (redeliverApproval)`);
  }
  const bridgeUrl = bridgeUrlFrom(args, bot);
  const appUrl = bridgeUrl.endsWith('/api/grokbot') ? bridgeUrl.slice(0, -'/api/grokbot'.length) : new URL(bridgeUrl).origin;
  const name = String(a.params?.name ?? '');
  const prompt = readSetupPrompt();
  const fill = (t) => t.split('<YOUR_APP_URL>/api/grokbot').join(bridgeUrl).split('<YOUR_APP_URL>').join(appUrl);
  const enrollLine = `node ~/.grokbot-bridge/plugin/grokbot-bridge.mjs enroll --bot-id <BOT_ID> --name ${shq(name)} --bridge-url ${shq(bridgeUrl)} --inbound-url '<routine webhook URL>' --description '<DESCRIPTION>' --enrollment-code ${shq(a.enrollmentCode)}`;
  const text = [
    `=== grokbot-bridge handoff: connect "${name}" to ${appUrl} ===`,
    `You were just created as "${name}" by your teammate ${bot.name || bot.botId}${bot.handle ? ` (@${bot.handle})` : ''}. The app owner approved this in the app (approval ${id}). Connect yourself to the app by following the setup prompt below, with these changes:`,
    `- Skip step 4. You do not need the enrollment secret. Instead you have a one-time enrollment code (below). It works once, only for a bot named exactly "${name}", and expires at ${a.enrollmentCodeExpiresAt || 'within the hour'} (UTC). Never print it, log it, store it in a file, or pass it on.`,
    `- In step 7, enroll with this command instead (fill in <BOT_ID>, <routine webhook URL> and <DESCRIPTION> as the steps describe; keep the name exactly as shown):`,
    `  ${enrollLine}`,
    `- If enroll says the code is invalid, used or expired, stop and say so. A code cannot be reused.`,
    ...soulHandoffLines(a, bridgeUrl),
    '',
    prompt ? '--- setup prompt ---' : `--- setup prompt: fetch it with: curl -fsSL https://raw.githubusercontent.com/imbavirus/grokbot-bridge-plugin/main/SETUP_PROMPT.md (use the text below its --- line; replace <YOUR_APP_URL> with ${appUrl}) ---`,
    ...(prompt ? [fill(prompt)] : []),
    '=== end of handoff ===',
  ].join('\n');
  if (args.json) return out({ ok: true, approvalId: id, name, appUrl, bridgeUrl, enrollmentCodeExpiresAt: a.enrollmentCodeExpiresAt ?? null, text });
  process.stdout.write(text + '\n');
  note('the handoff contains the one-time enrollment code: send it only to the new bot');
}

// What the creator tells the new bot about its soul: the approved text (if any) and where to fetch it from from now on.
function soulHandoffLines(a, bridgeUrl) {
  const soul = typeof a.params?.soul === 'string' ? a.params.soul.trim() : '';
  const where = `the app's soul endpoint (GET ${bridgeUrl}/soul, which \`${CLI_CMD} soul pull --bot-id <BOT_ID>\` calls with your own token)`;
  if (!soul) {
    return [`- Your soul (persona): none was set when you were created. My owner may set one in the app later; it is served by ${where}. You will get a signed soul_updated notice when it changes, and you adopt it then (routine rule 8).`];
  }
  return [
    `- Your soul (persona), as approved by my owner in the app (version ${soulVersionOf(soul)}):`,
    '  <<<SOUL',
    ...soul.split('\n').map((l) => `  ${l}`),
    '  SOUL>>>',
    `- The app is the source of truth for your soul: after enrolling, \`enroll\` fetches it from ${where}. Adopt THAT copy as your persona (setup step 8 and routine rule 8), then run the \`appliedWith\` command it prints. Fetch it again whenever the app says it changed (soul_updated notice, or \`_bridge.soul.stale\` on a message).`,
  ];
}

async function cmdApproval(args) {
  const sub = args._[1];
  const subs = { request: approvalRequest, show: approvalShow, list: null, complete: null, fail: null, handoff: approvalHandoff };
  if (!sub || !(sub in subs)) throw new CliError(1, 'usage: approval request|show|list|complete|fail|handoff (see --help)');
  const state = loadState();
  const bot = selectBot(state, args);
  if (sub === 'list') {
    const list = Object.values(bot.approvals || {}).map(redactApproval);
    return out({ ok: true, botId: bot.botId, approvals: list });
  }
  if (sub === 'complete' || sub === 'fail') return approvalFinish(args, state, bot, sub);
  return subs[sub](args, state, bot);
}

// ---------- soul (v0.5) ----------
function soulFile(botId) { return join(HOME_DIR, `soul.${botId}.md`); }
function soulVersionOf(text) { return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16); }
function appliedSoulVersion(bot) { return bot?.soul && 'appliedVersion' in bot.soul ? bot.soul.appliedVersion ?? null : null; }

async function pullSoul(state, bot, args) {
  const res = await http('GET', `${bridgeUrlFrom(args, bot)}/soul`, { headers: botHeaders(bot) });
  if (!('soul' in res)) throw new CliError(1, 'soul response did not include soul (is the app on grokbot-bridge-next 0.5+?)');
  const s = res.soul;
  const prev = state.bots[bot.botId].soul || {};
  const fetchedAt = new Date().toISOString();
  if (s === null) {
    rmSync(soulFile(bot.botId), { force: true });
    state.bots[bot.botId].soul = { ...prev, version: null, updatedAt: null, updatedBy: null, fetchedAt };
  } else {
    if (!s || typeof s.text !== 'string' || typeof s.version !== 'string' || !SOUL_VERSION_RE.test(s.version)) throw new CliError(1, 'malformed soul response');
    // soulVersion = leading hex of sha256(text): a cheap integrity check of what we are about to adopt.
    if (!createHash('sha256').update(s.text, 'utf8').digest('hex').startsWith(s.version.toLowerCase())) {
      throw new CliError(2, 'soul text does not match its version (corrupted in transit); do not adopt it');
    }
    writeSecureText(soulFile(bot.botId), s.text.endsWith('\n') ? s.text : `${s.text}\n`);
    state.bots[bot.botId].soul = { ...prev, version: s.version, updatedAt: s.updatedAt ?? null, updatedBy: s.updatedBy ?? null, fetchedAt };
  }
  if (res.memorySource && typeof res.memorySource === 'object') state.bots[bot.botId].memorySource = res.memorySource;
  saveState(state);
  return { soul: s, changed: (prev.version ?? null) !== (s?.version ?? null), applied: appliedSoulVersion(state.bots[bot.botId]), memorySource: res.memorySource ?? null };
}

function writeSecureText(file, text) {
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function soulNext(version, applied, botId) {
  if (version === null) {
    return applied === null
      ? 'no soul is set for you in this app: nothing to do'
      : `my owner removed your soul from this app: drop the persona you adopted from it (keep your own core instructions), then run appliedWith`;
  }
  if (version === applied) return 'already adopted: nothing to do';
  return `adopt this soul as your persona (rule 8): save it to your own profile/instructions and your memory, replacing any earlier soul from this app, then run appliedWith`;
}

function summariseSoul(pulled, botId) {
  const version = pulled.soul?.version ?? null;
  return {
    version, applied: pulled.applied, changed: pulled.changed,
    ...(version ? { file: soulFile(botId), updatedAt: pulled.soul.updatedAt ?? null, updatedBy: pulled.soul.updatedBy ?? null, showWith: `${CLI_CMD} soul show --bot-id ${botId}` } : {}),
    next: soulNext(version, pulled.applied, botId),
    ...(version !== pulled.applied ? { appliedWith: `${CLI_CMD} soul applied --bot-id ${botId} --version ${version ?? 'none'}` } : {}),
  };
}

async function cmdSoul(args) {
  const sub = args._[1];
  if (!['pull', 'show', 'applied'].includes(sub)) throw new CliError(1, 'usage: soul pull|show|applied (see --help)');
  const state = loadState();
  const bot = selectBot(state, args);
  if (sub === 'pull') {
    const pulled = await pullSoul(state, bot, args);
    return out({ ok: true, botId: bot.botId, ...summariseSoul(pulled, bot.botId), ...(pulled.soul ? { text: pulled.soul.text } : { text: null }), memorySource: pulled.memorySource });
  }
  const local = state.bots[bot.botId].soul || null;
  if (sub === 'show') {
    let text = null;
    if (local?.version) { try { text = readFileSync(soulFile(bot.botId), 'utf8').replace(/\n$/, ''); } catch {} }
    return out({
      ok: true, botId: bot.botId, source: 'local', version: local?.version ?? null, applied: appliedSoulVersion(state.bots[bot.botId]),
      fetchedAt: local?.fetchedAt ?? null, appliedAt: local?.appliedAt ?? null, ...(local?.version ? { file: soulFile(bot.botId) } : {}), text,
      ...(local ? {} : { hint: `never pulled: run ${CLI_CMD} soul pull --bot-id ${bot.botId}` }),
    });
  }
  // applied
  const want = args.version;
  if (!want) throw new CliError(1, "soul applied needs --version <version from soul pull> (or 'none' after a removed soul)");
  const v = want === 'none' ? null : want;
  if (v !== null && !SOUL_VERSION_RE.test(v)) throw new CliError(1, 'invalid --version');
  if (!local || !('fetchedAt' in local)) throw new CliError(1, `pull the soul first: ${CLI_CMD} soul pull --bot-id ${bot.botId}`);
  if ((local.version ?? null) !== v) throw new CliError(1, `--version ${want} is not the soul you pulled (${local.version ?? 'none'}); run soul pull again and adopt that one`);
  state.bots[bot.botId].soul = { ...local, appliedVersion: v, appliedAt: new Date().toISOString() };
  saveState(state);
  out({ ok: true, botId: bot.botId, applied: v });
}

// ---------- memory (v0.5) ----------
function memoryNext(src, botId) {
  if (!src || src.kind === 'none') return 'no memory source is set for you in this app: use only your own memory for this app\'s work';
  return `memory source "${src.kind}"${src.sharedRead ? ' (with read-only shared memory)' : ''}: for work done for this app, recall with ${CLI_CMD} memory search --bot-id ${botId} --query '<q>' and store outcomes with ${CLI_CMD} memory store --bot-id ${botId} (rule 9), alongside your own memory`;
}

async function memoryCall(args, bot, method, path, body) {
  try {
    return await http(method, `${bridgeUrlFrom(args, bot)}/${path}`, { headers: botHeaders(bot), ...(body ? { body: { botId: bot.botId, ...body } } : {}) });
  } catch (e) {
    if (e instanceof CliError && e.errorCode === 'memory_disabled') {
      throw new CliError(1, 'no memory source is set for you in this app (memory_disabled): use only your own memory', e);
    }
    if (e instanceof CliError && e.httpStatus === 429) throw new CliError(1, `${e.message} (rate limited: wait, then retry once)`, e);
    throw e;
  }
}

async function cmdMemory(args) {
  const sub = args._[1];
  if (!['status', 'search', 'store', 'read'].includes(sub)) throw new CliError(1, 'usage: memory status|search|store|read (see --help)');
  const state = loadState();
  const bot = selectBot(state, args);
  if (sub === 'status') {
    const res = await memoryCall(args, bot, 'GET', 'memory');
    if (res.memorySource) { state.bots[bot.botId].memorySource = res.memorySource; saveState(state); }
    return out({ ok: true, botId: bot.botId, memorySource: res.memorySource ?? null, enabled: !!res.enabled, capabilities: res.capabilities ?? null, next: memoryNext(res.memorySource, bot.botId) });
  }
  if (sub === 'search') {
    let query = args.query;
    if (query === undefined) query = (await readStdin()).trim();
    if (!query || !String(query).trim()) throw new CliError(1, "memory search needs --query '<text>' (or text on stdin)");
    if (query.length > MEMORY_QUERY_MAX) throw new CliError(1, `--query too long (max ${MEMORY_QUERY_MAX} chars)`);
    const body = { query };
    if (args.limit !== undefined) {
      const n = Number(args.limit);
      if (!Number.isInteger(n) || n < 1 || n > 50) throw new CliError(1, '--limit must be 1-50');
      body.limit = n;
    }
    if (args.scope !== undefined) {
      if (!['own', 'shared', 'all'].includes(args.scope)) throw new CliError(1, '--scope must be own, shared or all');
      body.scope = args.scope;
    }
    const res = await memoryCall(args, bot, 'POST', 'memory/search', body);
    return out({ ok: true, botId: bot.botId, areas: res.areas ?? null, results: Array.isArray(res.results) ? res.results : [] });
  }
  if (sub === 'store') {
    let text = args.text;
    if (text === undefined) text = (await readStdin()).replace(/\r?\n$/, '');
    if (!text || !text.trim()) throw new CliError(1, 'memory store needs --text <text> or text on stdin');
    if (text.length > MEMORY_TEXT_MAX) throw new CliError(1, `text too long (${text.length} > ${MEMORY_TEXT_MAX} chars)`);
    const body = { text };
    if (args.kind !== undefined) { if (!MEMORY_KIND_RE.test(args.kind)) throw new CliError(1, '--kind must be 1-40 chars of [a-z0-9_-]'); body.kind = args.kind; }
    if (args.title !== undefined) body.title = String(args.title).slice(0, 200);
    if (args.key !== undefined) { if (!ID_RE.test(args.key)) throw new CliError(1, `invalid --key: ${args.key}`); body.key = args.key; }
    if (args.append) { if (!body.key) throw new CliError(1, '--append needs --key <entry key>'); body.append = true; }
    if (args.tags !== undefined) {
      const tags = String(args.tags).split(',').map((t) => t.trim()).filter(Boolean);
      if (tags.length > 10 || tags.some((t) => !MEMORY_KIND_RE.test(t))) throw new CliError(1, '--tags must be up to 10 comma-separated [a-z0-9_-] words');
      body.tags = tags;
    }
    const res = await memoryCall(args, bot, 'POST', 'memory/store', body);
    return out({ ok: true, botId: bot.botId, id: res.id, created: res.created !== false, area: res.area || 'own' });
  }
  const id = args.id;
  if (!id || typeof id !== 'string' || id.length > 1000) throw new CliError(1, 'memory read needs --id <id from search or store>');
  const res = await memoryCall(args, bot, 'POST', 'memory/read', { id });
  out({ ok: true, botId: bot.botId, item: res.item ?? null });
}

async function cmdStatus(args) {
  const state = loadState();
  const ids = Object.keys(state.bots);
  if (!ids.length) {
    out({ ok: false, enrolled: false, stateFile: STATE_FILE, agents: listAgents(), bridgeUrl: getEnv('GROKBOT_BRIDGE_URL') || null, enrollmentSecretSet: !!getEnv('GROKBOT_ENROLLMENT_SECRET') });
    process.exitCode = 1;
    return;
  }
  const bot = selectBot(state, args);
  const local = { botId: bot.botId, name: bot.name, handle: bot.handle ? `@${bot.handle}` : null, inboundUrl: bot.inboundUrl, bridgeUrl: bot.bridgeUrl, enrolledAt: bot.enrolledAt, token: `${bot.token.slice(0, 4)}…(redacted, ${bot.token.length} chars)`, stateFile: STATE_FILE };
  if (args.offline) {
    return out({ ok: true, enrolled: true, ...local, soul: bot.soul ? { version: bot.soul.version ?? null, applied: appliedSoulVersion(bot) } : null, memorySource: bot.memorySource ?? null });
  }
  try {
    const res = await http('GET', `${bridgeUrlFrom(args, bot)}/me`, { headers: { authorization: `Bearer ${bot.token}`, 'x-grokbot-bot-id': bot.botId }, timeoutMs: Math.min(HTTP_TIMEOUT_MS, 6000) });
    const current = res.soul === undefined ? undefined : (res.soul?.version ?? null);
    const applied = appliedSoulVersion(bot);
    out({
      ok: true, enrolled: true, tokenValid: true, ...local,
      // Bot creation: only the app's designated creator bot may create bots ('approval' or 'auto'); everyone else is 'none'.
      createBotsPolicy: res.createBotsPolicy ?? 'none', creator: res.creator ?? null,
      ...(current !== undefined ? {
        soul: { version: current, applied, stale: current !== applied, ...(current !== applied ? { next: `run ${CLI_CMD} soul pull --bot-id ${bot.botId} and adopt it (rule 8)` } : {}) },
      } : {}),
      ...(res.memorySource ? { memorySource: res.memorySource } : {}),
      server: res.bot,
    });
  } catch (e) {
    out({ ok: false, enrolled: true, tokenValid: false, ...local, error: e.message });
    process.exitCode = 1;
  }
}

async function cmdRooms(args) {
  const state = loadState();
  const bot = selectBot(state, args);
  const cached = loadRooms(bot.botId);
  if (cached && !args.refresh) return out({ ok: true, cached: true, cacheFile: roomsFile(bot.botId), ...cached });
  const res = await http('GET', `${bridgeUrlFrom(args, bot)}/rooms`, { headers: { authorization: `Bearer ${bot.token}`, 'x-grokbot-bot-id': bot.botId } });
  if (!Array.isArray(res.rooms)) throw new CliError(1, 'rooms response did not include rooms');
  const cache = { botId: bot.botId, self: res.self, ...(res.createBotsPolicy ? { createBotsPolicy: res.createBotsPolicy } : {}), creator: res.creator ?? null, fetchedAt: res.fetchedAt || new Date().toISOString(), rooms: res.rooms };
  saveRooms(bot.botId, cache);
  out({ ok: true, cached: false, cacheFile: roomsFile(bot.botId), ...cache });
}

async function cmdProfile(args) {
  const state = loadState();
  const bot = selectBot(state, args);
  let description = args.description;
  if (description === undefined) description = (await readStdin()).trim();
  if (!description) throw new CliError(1, 'profile needs --description <text> (or text on stdin)');
  if (description.length > MAX_DESCRIPTION_CHARS) throw new CliError(1, `description too long (${description.length} > ${MAX_DESCRIPTION_CHARS} chars)`);
  const res = await http('POST', `${bridgeUrlFrom(args, bot)}/profile`, {
    headers: { authorization: `Bearer ${bot.token}`, 'x-grokbot-bot-id': bot.botId },
    body: { botId: bot.botId, description },
  });
  state.bots[bot.botId].description = res.bot?.description ?? description;
  saveState(state);
  out({ ok: true, botId: bot.botId, handle: bot.handle ? `@${bot.handle}` : null, description: state.bots[bot.botId].description });
}

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

const HELP = `grokbot-bridge ${VERSION}
Usage: node grokbot-bridge.mjs <command> [options]
  enroll  --inbound-url <url> [--description <text>] [--bot-id <id>] [--name <name>] [--bridge-url <url>] [--enrollment-code gbe_...]
  send    [--text <text>] [--room <roomId>] [--in-reply-to <id>] [--conversation-id <id>] [--type reply|message|event]   (text may come from stdin)
  verify  [--body <json> | --body-file <path>] [--signature "t=..,v1=.."] [--max-age <sec>] [--no-dedupe]   (body may come from stdin)
  rooms   [--refresh]          rooms you are in + rosters (cached in ~/.grokbot-bridge/rooms.<botId>.json)
  profile --description <text> update what you offer (max ${MAX_DESCRIPTION_CHARS} chars)
  status  [--offline]
  approval request [--kind create_bot] --name <name> --description <text> [--purpose <text>] [--reason <text>]   (other kinds: --params '<json>')
  approval show --id <approvalId> [--remote]     stored approval (enrollment code redacted); --remote asks the app
  approval list                                  approvals stored for this bot (redacted)
  approval complete --id <approvalId> [--result '<json>']
  approval fail --id <approvalId> --error '<one line>'
  approval handoff --id <approvalId> [--json]    setup block for the bot you created (contains its one-time code)
  approval request ... [--soul <text> | --soul-file <path>]   create_bot: propose the new bot's initial soul (max ${CREATE_BOT_SOUL_MAX} chars)
  soul pull                     fetch your soul (persona) from the app; saves ~/.grokbot-bridge/soul.<botId>.md (0600)
  soul show                     the soul you last pulled (local)
  soul applied --version <v>    record that you adopted that version into your profile/memory ('none' after a removal)
  memory status                 your memory source for this app (none | viking | ...) and what it supports
  memory search --query <q> [--limit 1-50] [--scope own|shared|all]   recall from your app memory (query may come from stdin)
  memory store [--text <t>] [--kind k] [--title t] [--key k [--append]] [--tags a,b]   store into your own app memory (text may come from stdin)
  memory read --id <id>         full text of one entry from search/store
Global: --bot-id <id> (or GROKBOT_BOT_ID). Defaults to the only bot enrolled in state.json; required when several are.
Env: GROKBOT_BRIDGE_URL, GROKBOT_ENROLLMENT_SECRET (process env, ./.env, script-dir .env, or ~/.grokbot-bridge/.env)
     GROKBOT_ENROLLMENT_CODE (process env only): one-time code instead of the secret
State: ${STATE_FILE} (0600)`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help || cmd === 'help') { process.stdout.write(HELP + '\n'); return; }
  const commands = { enroll: cmdEnroll, send: cmdSend, verify: cmdVerify, status: cmdStatus, rooms: cmdRooms, profile: cmdProfile, approval: cmdApproval, soul: cmdSoul, memory: cmdMemory };
  if (!commands[cmd]) throw new CliError(1, `unknown command "${cmd}" (try: enroll, send, verify, rooms, profile, approval, soul, memory, status)`);
  await commands[cmd](args);
}

main().then(
  () => { clearTimeout(watchdog); },
  (e) => fail(e instanceof CliError ? e.exitCode : 1, e?.message || String(e)),
);
