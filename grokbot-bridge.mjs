#!/usr/bin/env node
// grokbot-bridge — zero-dependency CLI that connects a Grok Bot to an app's
// /api/grokbot/* bridge route. Node 18+ built-ins only. MIT licensed.
//
//   node grokbot-bridge.mjs enroll  --inbound-url <url> [--description <text>] [--bot-id <id>] [--name <name>]
//   node grokbot-bridge.mjs send    --text <text> [--room <roomId>] [--in-reply-to <id>] [--conversation-id <id>]
//   node grokbot-bridge.mjs verify  [--body <json> | --body-file <path>]   (or stdin)
//   node grokbot-bridge.mjs rooms   [--refresh]
//   node grokbot-bridge.mjs profile --description <text>
//   node grokbot-bridge.mjs status
//
// --bot-id defaults to the only bot enrolled in state.json.
// Exit codes: 0 ok, 1 usage/config/network error, 2 bad signature or stale
// message, 3 duplicate message (already processed).

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.3.0';
const HTTP_TIMEOUT_MS = Number(process.env.GROKBOT_BRIDGE_TIMEOUT_MS) || 10_000;
const HARD_DEADLINE_MS = HTTP_TIMEOUT_MS + 8_000;
const DEFAULT_MAX_AGE_SEC = 300;
const MAX_TEXT_CHARS = 100_000;
const MAX_DESCRIPTION_CHARS = 500;
const SEEN_PER_BOT = 500;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// Never hang: hard watchdog for the whole process.
const watchdog = setTimeout(() => fail(1, `timed out after ${HARD_DEADLINE_MS}ms`), HARD_DEADLINE_MS);
watchdog.unref();

class CliError extends Error {
  constructor(code, message) { super(message); this.exitCode = code; }
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
const BOOL_FLAGS = new Set(['no-dedupe', 'offline', 'help', 'json', 'refresh']);
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
    throw new CliError(1, `${method} ${url} -> HTTP ${res.status}: ${msg}`);
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
  const secret = getEnv('GROKBOT_ENROLLMENT_SECRET');
  if (!secret) throw new CliError(1, 'GROKBOT_ENROLLMENT_SECRET is not set (add it via your secret input or ~/.grokbot-bridge/.env)');
  const { botId, name } = resolveIdentity(args);
  const description = args.description ?? process.env.GROKBOT_BOT_DESCRIPTION;
  if (description !== undefined && description.length > MAX_DESCRIPTION_CHARS) throw new CliError(1, `--description too long (max ${MAX_DESCRIPTION_CHARS} chars)`);
  const bridgeUrl = bridgeUrlFrom(args);
  const res = await http('POST', `${bridgeUrl}/enroll`, {
    headers: { authorization: `Bearer ${secret}` },
    body: { botId, name, inboundUrl, ...(description !== undefined ? { description } : {}) },
  });
  if (typeof res.token !== 'string' || res.token.length < 20) throw new CliError(1, 'enroll response did not include a token');
  const state = loadState();
  state.bots[botId] = {
    botId, name: res.bot?.name || name, handle: res.handle || res.bot?.handle, description: res.bot?.description ?? description ?? '',
    token: res.token, inboundUrl: res.bot?.inboundUrl || inboundUrl, bridgeUrl, enrolledAt: res.bot?.updatedAt || new Date().toISOString(),
  };
  saveState(state);
  const b = state.bots[botId];
  out({ ok: true, botId, name: b.name, handle: b.handle ? `@${b.handle}` : null, description: b.description, inboundUrl: b.inboundUrl, bridgeUrl, rotated: !!res.rotated, stateFile: STATE_FILE });
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

  const id = payload.messageId;
  if (!args['no-dedupe'] && typeof id === 'string') {
    const seen = (state.seen[bot.botId] ||= []);
    if (seen.includes(id)) throw new CliError(3, `duplicate message ${id} (already processed)`);
    seen.push(id);
    if (seen.length > SEEN_PER_BOT) seen.splice(0, seen.length - SEEN_PER_BOT);
    saveState(state);
  }
  process.stdout.write(JSON.stringify({ ...payload, _bridge: classify(bot.botId, payload) }) + '\n');
}

const NOTICE_TYPES = new Set(['room_member_joined', 'room_member_left', 'room_deleted']);
const CLI_CMD = 'node ~/.grokbot-bridge/plugin/grokbot-bridge.mjs';

// Tell the routine what to do with a verified payload, and keep the rooms cache in sync.
function classify(botId, p) {
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
  if (args.offline) return out({ ok: true, enrolled: true, ...local });
  try {
    const res = await http('GET', `${bridgeUrlFrom(args, bot)}/me`, { headers: { authorization: `Bearer ${bot.token}`, 'x-grokbot-bot-id': bot.botId }, timeoutMs: Math.min(HTTP_TIMEOUT_MS, 6000) });
    out({ ok: true, enrolled: true, tokenValid: true, ...local, server: res.bot });
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
  const cache = { botId: bot.botId, self: res.self, fetchedAt: res.fetchedAt || new Date().toISOString(), rooms: res.rooms };
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
  enroll  --inbound-url <url> [--description <text>] [--bot-id <id>] [--name <name>] [--bridge-url <url>]
  send    [--text <text>] [--room <roomId>] [--in-reply-to <id>] [--conversation-id <id>] [--type reply|message|event]   (text may come from stdin)
  verify  [--body <json> | --body-file <path>] [--signature "t=..,v1=.."] [--max-age <sec>] [--no-dedupe]   (body may come from stdin)
  rooms   [--refresh]          rooms you are in + rosters (cached in ~/.grokbot-bridge/rooms.<botId>.json)
  profile --description <text> update what you offer (max ${MAX_DESCRIPTION_CHARS} chars)
  status  [--offline]
Global: --bot-id <id> (or GROKBOT_BOT_ID). Defaults to the only bot enrolled in state.json; required when several are.
Env: GROKBOT_BRIDGE_URL, GROKBOT_ENROLLMENT_SECRET (process env, ./.env, script-dir .env, or ~/.grokbot-bridge/.env)
State: ${STATE_FILE} (0600)`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help || cmd === 'help') { process.stdout.write(HELP + '\n'); return; }
  const commands = { enroll: cmdEnroll, send: cmdSend, verify: cmdVerify, status: cmdStatus, rooms: cmdRooms, profile: cmdProfile };
  if (!commands[cmd]) throw new CliError(1, `unknown command "${cmd}" (try: enroll, send, verify, rooms, profile, status)`);
  await commands[cmd](args);
}

main().then(
  () => { clearTimeout(watchdog); },
  (e) => fail(e instanceof CliError ? e.exitCode : 1, e?.message || String(e)),
);
