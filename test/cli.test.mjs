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

test('send --room: suppressed message exits 0, prints reason + hint, one-line stderr hint; delivered one is quiet', async () => {
  const replies = [
    { ok: true, messageId: 'x1', roomId: 'room_1', duplicate: false, hop: 3, suppressed: 'low_value', suppressedDetail: 'acknowledgement-only', hint: 'not delivered: low_value (acknowledgement-only); only post new information', recipients: [] },
    { ok: true, messageId: 'x2', roomId: 'room_1', duplicate: false, hop: 4, suppressed: 'duplicate', suppressedDetail: 'repeats m-1 by @bravo', recipients: [] }, // older server: no hint
    { ok: true, messageId: 'x3', roomId: 'room_1', duplicate: false, hop: 4, suppressed: null, recipients: ['bravo'] },
  ];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    res.setHeader('content-type', 'application/json');
    res.writeHead(202).end(JSON.stringify(replies.shift()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = box();
  const url = `http://127.0.0.1:${server.address().port}/api/grokbot`;
  const send = (text) => new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'send', '--bridge-url', url, '--room', 'room_1', '--text', text], { env, timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
  try {
    const a = await send('agreed!');
    assert.equal(a.code, 0, a.stderr);
    const ja = JSON.parse(a.stdout);
    assert.equal(ja.suppressed, 'low_value');
    assert.equal(ja.suppressedDetail, 'acknowledgement-only');
    assert.deepEqual(ja.deliveredTo, []);
    assert.equal(a.stderr, 'grokbot-bridge: not delivered: low_value (acknowledgement-only); only post new information\n');
    const b = await send('the fix is in the parser');
    assert.equal(b.code, 0);
    assert.equal(JSON.parse(b.stdout).hint, 'not delivered: duplicate (repeats a recent message); only post new information');
    assert.match(b.stderr, /^grokbot-bridge: not delivered: duplicate/);
    const c = await send('new finding: line 42');
    assert.equal(c.code, 0);
    assert.deepEqual(JSON.parse(c.stdout), { ok: true, messageId: 'x3', roomId: 'room_1', duplicate: false, hop: 4, suppressed: null, deliveredTo: ['@bravo'] });
    assert.equal(c.stderr, '');
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- approvals (v0.4)
const hashParams = (params) => createHash('sha256').update(canon(params)).digest('hex');
const CODE = 'gbe_' + randomBytes(32).toString('base64url');
const decision = (over = {}) => {
  const params = over.params ?? { name: 'Release Notes Bot', description: 'Writes release notes.' };
  return {
    type: 'approval_decision', messageId: `d-${Math.random()}`, approvalId: 'apr_0123456789abcdef', kind: 'create_bot', status: 'approved',
    params, paramsHash: hashParams(params), decidedBy: 'Justin', decidedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 864e5).toISOString(), enrollmentCode: CODE, enrollmentCodeExpiresAt: new Date(Date.now() + 36e5).toISOString(),
    sentAt: new Date().toISOString(), ...over,
  };
};
const without = (o, ...keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const stateOf = (env) => JSON.parse(readFileSync(join(env.GROKBOT_BRIDGE_HOME, 'state.json'), 'utf8'));

test('verify: approval_decision -> kind action, code redacted in output but stored 0600; handoff prints it once', () => {
  const env = box();
  const r = run(['verify'], env, JSON.stringify(envelope(decision())));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(CODE), 'code never printed by verify');
  const o = JSON.parse(r.stdout);
  assert.match(o.enrollmentCode, /^gbe_…\(redacted, \d+ chars\)$/);
  assert.equal(o._bridge.kind, 'action');
  assert.equal(o._bridge.noReply, true);
  assert.deepEqual(o._bridge.action, { approvalId: 'apr_0123456789abcdef', kind: 'create_bot', status: 'approved', params: { name: 'Release Notes Bot', description: 'Writes release notes.' } });
  assert.match(o._bridge.completeWith, /approval complete --bot-id .* --id apr_0123456789abcdef/);
  const st = stateOf(env);
  assert.equal(st.bots[BOT].approvals.apr_0123456789abcdef.enrollmentCode, CODE);
  assert.equal(statSync(join(env.GROKBOT_BRIDGE_HOME, 'state.json')).mode & 0o777, 0o600);
  const show = run(['approval', 'show', '--id', 'apr_0123456789abcdef'], env);
  assert.ok(!show.stdout.includes(CODE));
  const list = run(['approval', 'list'], env);
  assert.ok(!list.stdout.includes(CODE));
  assert.equal(JSON.parse(list.stdout).approvals.length, 1);
  const ho = run(['approval', 'handoff', '--id', 'apr_0123456789abcdef'], env);
  assert.equal(ho.status, 0, ho.stderr);
  assert.ok(ho.stdout.includes(`--enrollment-code '${CODE}'`));
  assert.ok(ho.stdout.includes("--bridge-url 'http://127.0.0.1:1/api/grokbot'"));
  assert.ok(ho.stdout.includes('connect "Release Notes Bot" to http://127.0.0.1:1'));
  assert.ok(!ho.stdout.includes('<YOUR_APP_URL>'));
  assert.match(ho.stderr, /send it only to the new bot/);
});

test('verify: paramsHash mismatch is rejected (exit 2) and nothing is stored', () => {
  const env = box();
  const d = decision();
  const tampered = { ...d, params: { ...d.params, name: 'Admin Bot' } }; // re-signed, but hash is for the old params
  const r = run(['verify'], env, JSON.stringify(envelope(tampered)));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /paramsHash does not match params/);
  assert.equal(stateOf(env).bots[BOT].approvals, undefined);
});

test('verify: denied/expired -> stop silently; handoff refuses; names with quotes are shell-quoted', () => {
  const env = box();
  const o = JSON.parse(run(['verify'], env, JSON.stringify(envelope(without(decision({ status: 'denied', reason: 'no' }), 'enrollmentCode', 'enrollmentCodeExpiresAt')))).stdout);
  assert.match(o._bridge.next, /stop silently/);
  assert.equal(run(['approval', 'handoff', '--id', 'apr_0123456789abcdef'], env).status, 1);
  const env2 = box();
  const params = { name: "O'Brien Bot", description: '' };
  run(['verify'], env2, JSON.stringify(envelope(decision({ params, approvalId: 'apr_quotes00000000' }))));
  const ho = run(['approval', 'handoff', '--id', 'apr_quotes00000000'], env2);
  assert.ok(ho.stdout.includes(`--name 'O'\\''Brien Bot'`), ho.stdout);
  // expired code -> handoff refuses
  const env3 = box();
  run(['verify'], env3, JSON.stringify(envelope(decision({ approvalId: 'apr_expired0000000', enrollmentCodeExpiresAt: new Date(Date.now() - 1000).toISOString() }))));
  const ex = run(['approval', 'handoff', '--id', 'apr_expired0000000'], env3);
  assert.equal(ex.status, 1);
  assert.match(ex.stderr, /expired/);
});

test('approval request/complete/fail and enroll --enrollment-code talk to the app correctly', async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/approvals')) return res.writeHead(202).end(JSON.stringify({ ok: true, approvalId: 'apr_fromserver000000', status: 'pending', expiresAt: 'later' }));
    if (req.url.endsWith('/complete')) {
      if (seen.filter((s) => s.url.endsWith('/complete')).length > 1) return res.writeHead(409).end(JSON.stringify({ ok: false, error: { code: 'already_completed', message: 'approval apr_0123456789abcdef is already completed' } }));
      return res.end(JSON.stringify({ ok: true, approval: { status: 'completed', completedAt: 'now' } }));
    }
    if (req.url.endsWith('/fail')) return res.end(JSON.stringify({ ok: true, approval: { status: 'failed' } }));
    if (req.url.endsWith('/enroll')) {
      if (req.headers.authorization !== `Bearer ${CODE}`) return res.writeHead(401).end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'invalid, used or expired enrollment code' } }));
      return res.writeHead(201).end(JSON.stringify({ ok: true, token: 'gbt_' + 'n'.repeat(43), handle: 'release-notes-bot', bot: { name: 'Release Notes Bot', handle: 'release-notes-bot', createdByBotId: BOT, approvalId: 'apr_0123456789abcdef' } }));
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/grokbot`;
  const env = box();
  const st0 = stateOf(env); st0.bots[BOT].bridgeUrl = url; writeFileSync(join(env.GROKBOT_BRIDGE_HOME, 'state.json'), JSON.stringify(st0), { mode: 0o600 });
  const runA = (args, e = env) => new Promise((resolve) => {
    const c = execFile(process.execPath, [CLI, ...args], { env: e, timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    c.stdin.end('');
  });
  try {
    const rq = await runA(['approval', 'request', '--kind', 'create_bot', '--name', 'Release  Notes Bot', '--description', 'Writes release notes.', '--reason', 'asked in room']);
    assert.equal(rq.code, 0, rq.stderr);
    assert.equal(JSON.parse(rq.stdout).approvalId, 'apr_fromserver000000');
    assert.equal(seen[0].auth, `Bearer ${token}`);
    assert.deepEqual(seen[0].body.params, { name: 'Release Notes Bot', description: 'Writes release notes.' });
    assert.equal(seen[0].body.kind, 'create_bot');
    assert.equal(seen[0].body.reason, 'asked in room');
    assert.match(seen[0].body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(stateOf(env).bots[BOT].approvals.apr_fromserver000000.status, 'pending');
    assert.equal((await runA(['approval', 'request', '--name', 'x'.repeat(61)])).code, 1);
    assert.equal((await runA(['approval', 'request', '--kind', 'deploy'])).code, 1); // needs --params
    // complete: stores status, drops the code; second time -> 409 already_completed -> exit 0
    run(['verify'], env, JSON.stringify(envelope(decision())));
    const c1 = await runA(['approval', 'complete', '--id', 'apr_0123456789abcdef', '--result', '{"createdBotId":"n1","createdBotName":"Release Notes Bot"}']);
    assert.equal(c1.code, 0, c1.stderr);
    assert.deepEqual(seen.at(-1).body.result, { createdBotId: 'n1', createdBotName: 'Release Notes Bot' });
    const st = stateOf(env).bots[BOT].approvals.apr_0123456789abcdef;
    assert.equal(st.status, 'completed');
    assert.equal(st.enrollmentCode, undefined);
    const c2 = await runA(['approval', 'complete', '--id', 'apr_0123456789abcdef']);
    assert.equal(c2.code, 0);
    assert.equal(JSON.parse(c2.stdout).alreadyFinished, true);
    assert.equal((await runA(['approval', 'complete', '--id', 'apr_0123456789abcdef', '--result', 'not json'])).code, 1);
    const f = await runA(['approval', 'fail', '--id', 'apr_0123456789abcdef', '--error', 'quota']);
    assert.equal(f.code, 0);
    assert.equal(seen.at(-1).body.error, 'quota');
    assert.equal((await runA(['approval', 'fail', '--id', 'apr_0123456789abcdef'])).code, 1); // --error required
    // enroll with a code: Bearer <code>, no secret needed; bad code -> friendly one-liner
    const nb = { ...box(), GROKBOT_ENROLLMENT_SECRET: '' };
    const en = await runA(['enroll', '--bot-id', BOT2, '--name', 'Release Notes Bot', '--bridge-url', url, '--inbound-url', 'https://x.test/h', '--enrollment-code', CODE], nb);
    assert.equal(en.code, 0, en.stderr);
    assert.equal(seen.at(-1).auth, `Bearer ${CODE}`);
    assert.deepEqual(JSON.parse(en.stdout).enrolledWith, 'enrollment_code');
    assert.ok(!en.stdout.includes(CODE));
    const bad = await runA(['enroll', '--bot-id', BOT2, '--name', 'Release Notes Bot', '--bridge-url', url, '--inbound-url', 'https://x.test/h'], { ...nb, GROKBOT_ENROLLMENT_CODE: 'gbe_' + 'z'.repeat(43) });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /cannot be reused/);
    assert.equal(bad.stderr.trim().split('\n').length, 1);
    assert.equal((await runA(['enroll', '--inbound-url', 'https://x.test/h', '--enrollment-code', 'secret-not-code'], nb)).code, 1);
  } finally {
    server.close();
  }
});

test('creator bot: sync approved/denied decisions from approval request; status shows createBotsPolicy + creator; none -> 403', async () => {
  let mode = 'auto';
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/me')) return res.end(JSON.stringify({ ok: true, bot: { botId: BOT }, createBotsPolicy: 'auto', creator: { botId: BOT, handle: 'botfather', name: 'Botfather', isSelf: true } }));
    if (req.url.endsWith('/approvals')) {
      const { params } = JSON.parse(body);
      if (mode === 'none') return res.writeHead(403).end(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'you may not create bots (create-bots policy: none); bot creation in this app is handled by the creator bot @botfather (Botfather)' } }));
      const tamper = mode === 'tamper';
      const status = mode === 'deny' ? 'denied' : 'approved';
      const d = decision({ approvalId: 'apr_sync0000000000', status, params: tamper ? { ...params, name: 'Other' } : params, decidedBy: 'policy:auto', ...(status === 'denied' ? { reason: 'denied by app policy' } : {}) });
      if (status === 'denied') { delete d.enrollmentCode; delete d.enrollmentCodeExpiresAt; }
      return res.writeHead(202).end(JSON.stringify({ ok: true, approvalId: 'apr_sync0000000000', status, decidedByPolicy: 'policy:auto', decision: d }));
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/grokbot`;
  const mk = () => { const e = box(); const st = stateOf(e); st.bots[BOT].bridgeUrl = url; writeFileSync(join(e.GROKBOT_BRIDGE_HOME, 'state.json'), JSON.stringify(st), { mode: 0o600 }); return e; };
  const runA = (args, e) => new Promise((resolve) => {
    const c = execFile(process.execPath, [CLI, ...args], { env: e, timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    c.stdin.end('');
  });
  const req = ['approval', 'request', '--name', 'Release Notes Bot', '--description', 'Writes release notes.'];
  try {
    const env = mk();
    const st = JSON.parse((await runA(['status'], env)).stdout);
    assert.equal(st.createBotsPolicy, 'auto');
    assert.equal(st.creator.handle, 'botfather');
    const r = await runA(req, env);
    assert.equal(r.code, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.status, 'approved');
    assert.equal(o.autoApproved, true);
    assert.match(o.handoffWith, /approval handoff --bot-id .* --id apr_sync0000000000/);
    assert.ok(!r.stdout.includes(CODE), 'code redacted in request output');
    assert.equal(stateOf(env).bots[BOT].approvals.apr_sync0000000000.enrollmentCode, CODE);
    const ho = await runA(['approval', 'handoff', '--id', 'apr_sync0000000000'], env);
    assert.equal(ho.code, 0, ho.stderr);
    assert.ok(ho.stdout.includes(`--enrollment-code '${CODE}'`), 'handoff right after request, no waiting');
    mode = 'deny';
    const env2 = mk();
    const dn = JSON.parse((await runA(req, env2)).stdout);
    assert.equal(dn.status, 'denied');
    assert.match(dn.next, /do not create it/);
    assert.equal(stateOf(env2).bots[BOT].approvals.apr_sync0000000000.enrollmentCode, undefined);
    mode = 'tamper';
    const tp = await runA(req, mk());
    assert.equal(tp.code, 2);
    mode = 'none';
    const nn = await runA(req, mk());
    assert.equal(nn.code, 1);
    assert.match(nn.stderr, /HTTP 403: .*handled by the creator bot @botfather/);
  } finally {
    server.close();
  }
});
