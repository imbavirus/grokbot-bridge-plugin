// Self-contained checks for the CLI. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'grokbot-bridge.mjs');
const BOT = '11111111-2222-4333-8444-555555555555';
const token = 'gbt_' + randomBytes(32).toString('base64url');

const canon = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
function envelope(payload, t = Math.floor(Date.now() / 1000), tok = token) {
  const key = createHash('sha256').update(tok).digest();
  return { v: 1, t, sig: createHmac('sha256', key).update(`${t}.${canon(payload)}`).digest('hex'), payload };
}
function box() {
  const home = mkdtempSync(join(tmpdir(), 'gbb-plugin-'));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, bots: { [BOT]: { botId: BOT, name: 'T', token, bridgeUrl: 'http://127.0.0.1:1/api/grokbot' } }, seen: {} }), { mode: 0o600 });
  return { ...process.env, GROKBOT_BRIDGE_HOME: home, GROKBOT_AGENTS_DIR: join(home, 'agents') };
}
const run = (args, env, input) => spawnSync(process.execPath, [CLI, ...args], { env, input: input ?? '', encoding: 'utf8', timeout: 20000 });
const p = (id = 'm1') => ({ type: 'message', messageId: id, text: 'hello', sentAt: new Date().toISOString() });

test('help works and is fast', () => {
  const r = run(['--help'], process.env);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /enroll\s+--inbound-url/);
  assert.match(r.stdout, /rooms\s+\[--refresh\]/);
  assert.match(r.stdout, /profile\s+--description/);
});

test('verify: good envelope prints payload; duplicate exits 3', () => {
  const env = box();
  const body = JSON.stringify(envelope(p()));
  const r = run(['verify'], env, body);
  assert.equal(r.status, 0, r.stderr);
  const outp = JSON.parse(r.stdout);
  assert.equal(outp.messageId, 'm1');
  assert.equal(outp._bridge.kind, 'direct');
  assert.equal(outp._bridge.reply, 'required');
  assert.equal(statSync(join(env.GROKBOT_BRIDGE_HOME, 'state.json')).mode & 0o777, 0o600);
  assert.equal(run(['verify'], env, body).status, 3);
});

test('verify: tampered, wrong token, stale -> exit 2', () => {
  const env = box();
  const e = envelope(p('m2'));
  assert.equal(run(['verify'], env, JSON.stringify({ ...e, payload: { ...e.payload, text: 'evil' } })).status, 2);
  assert.equal(run(['verify'], env, JSON.stringify(envelope(p('m3'), undefined, 'gbt_other'))).status, 2);
  const stale = run(['verify'], env, JSON.stringify(envelope(p('m4'), Math.floor(Date.now() / 1000) - 600)));
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /stale/);
});

test('send/enroll fail soft with a one-line error when misconfigured', () => {
  const env = box();
  const r = run(['enroll', '--inbound-url', 'https://x.test/hook'], { ...env, GROKBOT_BRIDGE_URL: '', GROKBOT_ENROLLMENT_SECRET: '' });
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('never hangs on an open, silent stdin', async () => {
  const env = box();
  const started = Date.now();
  const child = spawn(process.execPath, [CLI, 'verify'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const code = await new Promise((r) => child.on('exit', r));
  child.stdin.destroy();
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 5000);
});

// ---------------------------------------------------------------- rooms (v0.2)
const BOT2 = '99999999-2222-4333-8444-555555555555';
const token2 = 'gbt_' + randomBytes(32).toString('base64url');
function box2(bridgeUrl = 'http://127.0.0.1:1/api/grokbot') {
  const home = mkdtempSync(join(tmpdir(), 'gbb-plugin2-'));
  const bots = {
    [BOT]: { botId: BOT, name: 'Alpha', handle: 'alpha', token, bridgeUrl },
    [BOT2]: { botId: BOT2, name: 'Bravo', handle: 'bravo', token: token2, bridgeUrl },
  };
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, bots, seen: {} }), { mode: 0o600 });
  return { ...process.env, GROKBOT_BRIDGE_HOME: home, GROKBOT_AGENTS_DIR: join(home, 'agents') };
}
const roster = (ids, self) => ids.map(([botId, handle]) => ({ botId, handle, name: handle, description: `${handle} does things`, listenAll: false, isSelf: botId === self }));
const notice = (type, v, self, extra = {}) => ({
  type, messageId: `n-${type}-${v}-${Math.random()}`, roomId: 'room_1', room: { roomId: 'room_1', name: 'War Room', description: '' },
  rosterVersion: v, self: { botId: self, handle: self === BOT ? 'alpha' : 'bravo', name: 'x' }, roster: [], noReply: true, sentAt: new Date().toISOString(), ...extra,
});
const roomsCache = (env, id) => JSON.parse(readFileSync(join(env.GROKBOT_BRIDGE_HOME, `rooms.${id}.json`), 'utf8'));

test('--bot-id: defaults to the single enrolled bot, required when several are enrolled', () => {
  const env = box2();
  const body = JSON.stringify(envelope(p('d1')));
  const r = run(['verify'], env, body);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /several bots are enrolled.*--bot-id/);
  assert.equal(run(['verify', '--bot-id', BOT], env, body).status, 0);
  // the other bot's key does not verify this envelope
  assert.equal(run(['verify', '--bot-id', BOT2, '--no-dedupe'], env, body).status, 2);
});

test('membership notices update only that bot\'s rooms cache (0600) and say no reply', () => {
  const env = box2();
  const joined = notice('room_member_joined', 1, BOT, { member: roster([[BOT2, 'bravo']], BOT)[0], roster: roster([[BOT, 'alpha'], [BOT2, 'bravo']], BOT) });
  const r = run(['verify', '--bot-id', BOT], env, JSON.stringify(envelope(joined)));
  assert.equal(r.status, 0, r.stderr);
  const outp = JSON.parse(r.stdout);
  assert.equal(outp._bridge.kind, 'notice');
  assert.equal(outp._bridge.noReply, true);
  assert.equal(outp._bridge.cacheUpdated, true);
  const file = join(env.GROKBOT_BRIDGE_HOME, `rooms.${BOT}.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(existsSync(join(env.GROKBOT_BRIDGE_HOME, `rooms.${BOT2}.json`)), false);
  const c = roomsCache(env, BOT);
  assert.equal(c.rooms[0].rosterVersion, 1);
  assert.equal(c.rooms[0].members.find((m) => m.isSelf).botId, BOT);
  assert.equal(c.self.botId, BOT);

  // older notice ignored
  const old = run(['verify', '--bot-id', BOT], env, JSON.stringify(envelope(notice('room_member_left', 0, BOT, { member: roster([[BOT2, 'bravo']], BOT)[0] }))));
  assert.equal(JSON.parse(old.stdout)._bridge.cacheUpdated, false);
  assert.equal(roomsCache(env, BOT).rooms.length, 1);

  // the bot itself removed -> room dropped
  const leftMe = run(['verify', '--bot-id', BOT], env, JSON.stringify(envelope(notice('room_member_left', 2, BOT, { member: roster([[BOT, 'alpha']], BOT)[0] }))));
  assert.equal(JSON.parse(leftMe.stdout)._bridge.roomRemoved, true);
  assert.equal(roomsCache(env, BOT).rooms.length, 0);
});

test('room_message: flags a stale roster against the cache', () => {
  const env = box2();
  const joined = notice('room_member_joined', 3, BOT, { roster: roster([[BOT, 'alpha'], [BOT2, 'bravo']], BOT) });
  run(['verify', '--bot-id', BOT], env, JSON.stringify(envelope(joined)));
  const msg = (v, id) => ({ type: 'room_message', messageId: id, roomId: 'room_1', room: { roomId: 'room_1', name: 'War Room', description: '' }, rosterVersion: v,
    self: { botId: BOT, handle: 'alpha', name: 'Alpha' }, roster: [], author: { kind: 'user', name: 'Justin' }, text: '@alpha hi', mentions: [{ botId: BOT, handle: 'alpha' }],
    reason: 'mention', hop: 0, context: [], sentAt: new Date().toISOString() });
  const fresh = JSON.parse(run(['verify', '--bot-id', BOT], env, JSON.stringify(envelope(msg(3, 'rm1')))).stdout);
  assert.equal(fresh._bridge.kind, 'room');
  assert.equal(fresh._bridge.reply, 'optional');
  assert.equal(fresh._bridge.rosterStale, false);
  assert.match(fresh._bridge.replyWith, /send --bot-id .* --room room_1 --in-reply-to rm1/);
  const stale = JSON.parse(run(['verify', '--bot-id', BOT], env, JSON.stringify(envelope(msg(5, 'rm2')))).stdout);
  assert.equal(stale._bridge.rosterStale, true);
  assert.equal(stale._bridge.cachedRosterVersion, 3);
  assert.match(stale._bridge.hint, /rooms --bot-id .* --refresh/);
  // a bot with no cache at all is stale too
  const none = JSON.parse(run(['verify', '--bot-id', BOT2], env, JSON.stringify(envelope({ ...msg(1, 'rm3'), self: { botId: BOT2, handle: 'bravo', name: 'Bravo' } }, undefined, token2))).stdout);
  assert.equal(none._bridge.rosterStale, true);
  assert.equal(none._bridge.cachedRosterVersion, null);
});

test('rooms --refresh fetches with the bot token, caches per botId; profile updates description', async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, botId: req.headers['x-grokbot-bot-id'], body });
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/rooms')) {
      const self = req.headers['x-grokbot-bot-id'];
      res.end(JSON.stringify({ ok: true, self: { botId: self, handle: 'x', name: 'x' }, fetchedAt: new Date().toISOString(),
        rooms: [{ roomId: 'room_1', name: 'War Room', description: '', rosterVersion: 7, you: { listenAll: false }, members: roster([[BOT, 'alpha'], [BOT2, 'bravo']], self) }] }));
    } else if (req.url.endsWith('/profile')) {
      res.end(JSON.stringify({ ok: true, bot: { description: JSON.parse(body).description } }));
    } else res.writeHead(404).end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/grokbot`;
  const env = box2(url);
  const runA = (args, input) => new Promise((resolve) => {
    const c = execFile(process.execPath, [CLI, ...args], { env, timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    c.stdin.end(input ?? '');
  });
  try {
    const a = await runA(['rooms', '--bot-id', BOT, '--refresh']);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(JSON.parse(a.stdout).cached, false);
    assert.equal(seen[0].auth, `Bearer ${token}`);
    assert.equal(seen[0].botId, BOT);
    assert.ok(!a.stdout.includes(token), 'token never printed');
    assert.equal(roomsCache(env, BOT).rooms[0].rosterVersion, 7);
    assert.equal(existsSync(join(env.GROKBOT_BRIDGE_HOME, `rooms.${BOT2}.json`)), false);
    const again = JSON.parse((await runA(['rooms', '--bot-id', BOT])).stdout);
    assert.equal(again.cached, true);
    assert.equal(seen.length, 1, 'served from cache');
    const b = await runA(['rooms', '--bot-id', BOT2]);
    assert.equal(JSON.parse(b.stdout).self.botId, BOT2);
    assert.equal(seen[1].auth, `Bearer ${token2}`);
    const prof = await runA(['profile', '--bot-id', BOT, '--description', 'Ops runbooks and incident triage']);
    assert.equal(prof.code, 0, prof.stderr);
    assert.equal(JSON.parse(prof.stdout).description, 'Ops runbooks and incident triage');
    const st = JSON.parse(readFileSync(join(env.GROKBOT_BRIDGE_HOME, 'state.json'), 'utf8'));
    assert.equal(st.bots[BOT].description, 'Ops runbooks and incident triage');
    const tooLong = await runA(['profile', '--bot-id', BOT, '--description', 'x'.repeat(501)]);
    assert.equal(tooLong.code, 1);
  } finally {
    server.close();
  }
});
