// Self-contained checks for the CLI. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
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
  assert.match(r.stdout, /enroll --inbound-url/);
});

test('verify: good envelope prints payload; duplicate exits 3', () => {
  const env = box();
  const body = JSON.stringify(envelope(p()));
  const r = run(['verify'], env, body);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).messageId, 'm1');
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
