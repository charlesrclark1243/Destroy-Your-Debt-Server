// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, statSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimAccessUrl,
  claimUrlFromSetupToken,
  configPath,
  hostAllowed,
  loadConfig,
  normalizeAccountSet,
  originAllowed,
  saveConfig,
  tokenMatches,
  hashToken,
} from '../src/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://localhost:4200';

// ---- unit ----

test('decodes a setup token and refuses non-https claim URLs', () => {
  const ok = Buffer.from('https://bridge.example/simplefin/claim/ABC').toString('base64');
  assert.equal(claimUrlFromSetupToken(ok), 'https://bridge.example/simplefin/claim/ABC');
  const http = Buffer.from('http://evil.example/claim').toString('base64');
  assert.throws(() => claimUrlFromSetupToken(http), /https/);
  assert.throws(() => claimUrlFromSetupToken('not a token!'), /setup token/);
});

test('claims an access URL with a POST to the claim URL', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push([url, init.method]);
    return new Response('https://user:secret@bridge.example/simplefin\n', { status: 200 });
  };
  const token = Buffer.from('https://bridge.example/simplefin/claim/ABC').toString('base64');
  assert.equal(await claimAccessUrl(token, fake), 'https://user:secret@bridge.example/simplefin');
  assert.deepEqual(calls, [['https://bridge.example/simplefin/claim/ABC', 'POST']]);
  const used = async () => new Response('', { status: 403 });
  await assert.rejects(claimAccessUrl(token, used), /used already/);
});

test('normalizes SimpleFIN v2 accounts: numbers, bank names, dates in ms', () => {
  const out = normalizeAccountSet({
    errlist: [{ code: 'con.auth', msg: 'Discover needs you to sign in again.' }],
    connections: [{ conn_id: 'C1', org_name: 'Discover', name: 'Discover' }],
    accounts: [{ id: 'A1', name: 'Discover it', conn_id: 'C1', balance: '-3929.83', 'available-balance': '4070.17', 'balance-date': 1795564800, currency: 'USD' }],
  });
  assert.deepEqual(out.accounts[0], {
    id: 'A1', name: 'Discover it', org: 'Discover', balance: -3929.83, available: 4070.17, balanceDate: 1795564800000, currency: 'USD',
  });
  assert.deepEqual(out.errors, ['Discover needs you to sign in again.']);
});

test('only accepts our own host header and listed origins', () => {
  assert.ok(hostAllowed('127.0.0.1:47317', 47317));
  assert.ok(hostAllowed('localhost:47317', 47317));
  assert.ok(!hostAllowed('evil.example:47317', 47317));
  assert.ok(!hostAllowed('127.0.0.1:80', 47317));
  assert.ok(originAllowed('https://destroy-your-debt.com', ['https://destroy-your-debt.com']));
  assert.ok(!originAllowed('https://evil.example', ['https://destroy-your-debt.com']));
  assert.ok(!originAllowed(undefined, ['https://destroy-your-debt.com']));
});

test('stores the config readable only by the user, and matches token hashes', () => {
  const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'bs-')) };
  saveConfig({ accessUrl: 'https://u:p@x/simplefin', tokens: [{ hash: hashToken('t1') }] }, env);
  assert.equal(statSync(configPath(env)).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(configPath(env))).mode & 0o777, 0o700);
  assert.equal(loadConfig(env).accessUrl, 'https://u:p@x/simplefin');
  assert.ok(tokenMatches('t1', loadConfig(env).tokens.map((t) => t.hash)));
  assert.ok(!tokenMatches('t2', loadConfig(env).tokens.map((t) => t.hash)));
});

// ---- the running serverProc, against a fake SimpleFIN ----

let simplefin, simplefinHits = 0, serverProc, port, code, env;
const accountSet = {
  errlist: [],
  connections: [
    { conn_id: 'C-DISC', org_name: 'Discover' },
    { conn_id: 'C-CHASE', org_name: 'Chase Bank' },
  ],
  accounts: [
    { id: 'ACT-1', name: 'Discover it Card', conn_id: 'C-DISC', balance: '-3512.10', 'available-balance': '4487.90', 'balance-date': 1795564800, currency: 'USD' },
    { id: 'ACT-2', name: 'Prime Visa', conn_id: 'C-CHASE', balance: '-880.25', 'balance-date': 1795564800, currency: 'USD' },
  ],
};

before(async () => {
  simplefin = createServer((req, res) => {
    simplefinHits++;
    const auth = req.headers.authorization ?? '';
    if (auth !== 'Basic ' + Buffer.from('demo:pw').toString('base64')) {
      res.writeHead(403).end();
      return;
    }
    assert.match(req.url, /^\/simplefin\/accounts\?version=2&balances-only=1$/);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(accountSet));
  });
  await new Promise((r) => simplefin.listen(0, '127.0.0.1', r));
  const sfPort = simplefin.address().port;

  env = { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'bs-run-')) };
  saveConfig({ accessUrl: `http://demo:pw@127.0.0.1:${sfPort}/simplefin`, tokens: [] }, env);
  port = 47400 + Math.floor(Math.random() * 500);
  serverProc = spawn(process.execPath, [join(HERE, '..', 'src', 'cli.mjs'), 'serve'], {
    env: { ...env, DYD_PORT: String(port), DYD_ORIGINS: ORIGIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  code = await new Promise((resolve, reject) => {
    let out = '';
    serverProc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/Pairing code: (\d{3})-(\d{3})/);
      if (m) resolve(m[1] + m[2]);
    });
    serverProc.on('exit', (c) => reject(new Error('server exited ' + c + ' ' + out)));
  });
});

after(() => {
  serverProc?.kill();
  simplefin?.close();
  rmSync(env.XDG_CONFIG_HOME, { recursive: true, force: true });
});

const call = (path, { method = 'GET', origin = ORIGIN, token, body, host } = {}) =>
  new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (origin) headers.Origin = origin;
    if (token) headers.Authorization = 'Bearer ' + token;
    if (host) headers.Host = host;
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

test('refuses other websites, other host names, and unpaired requests', async () => {
  assert.equal((await call('/v1/status', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/v1/status', { origin: null })).status, 403);
  assert.equal((await call('/v1/status', { host: 'evil.example:' + port })).status, 403);
  const unpaired = await call('/v1/accounts');
  assert.equal(unpaired.status, 401);
  assert.equal(simplefinHits, 0);
});

test('answers the CORS preflight, including Chrome local-network access', async () => {
  const r = await call('/v1/accounts', { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.equal(r.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(r.headers['access-control-allow-private-network'], 'true');
});

let token;
test('pairs with the printed code once, and never reveals the access URL', async () => {
  assert.equal((await call('/v1/pair', { method: 'POST', body: { code: '000000' === code ? '111111' : '000000' } })).status, 401);
  const ok = await call('/v1/pair', { method: 'POST', body: { code: code.slice(0, 3) + '-' + code.slice(3) } });
  assert.equal(ok.status, 200);
  token = ok.body.token;
  assert.ok(token.length > 30);
  // The code is single-use.
  assert.equal((await call('/v1/pair', { method: 'POST', body: { code } })).status, 410);
  const status = await call('/v1/status', { token });
  assert.deepEqual(status.body, { app: 'destroy-your-debt-server', version: 1, linked: true, paired: true });
  assert.ok(!JSON.stringify(status.body).includes('pw'));
  // Only the token's hash is stored.
  const saved = readFileSync(configPath(env), 'utf8');
  assert.ok(!saved.includes(token));
});

test('returns balances, then serves them from cache (SimpleFIN allows ~24 requests a day)', async () => {
  const first = await call('/v1/accounts', { token });
  assert.equal(first.status, 200);
  assert.equal(first.body.cached, false);
  assert.deepEqual(first.body.accounts.map((a) => [a.org, a.name, a.balance]), [
    ['Discover', 'Discover it Card', -3512.1],
    ['Chase Bank', 'Prime Visa', -880.25],
  ]);
  const second = await call('/v1/accounts', { token });
  assert.equal(second.body.cached, true);
  const refresh = await call('/v1/accounts?refresh=1', { token });
  assert.equal(refresh.body.cached, true, 'a refresh within 15 minutes still uses the cache');
  assert.equal(simplefinHits, 1);
  assert.ok(!JSON.stringify(first.body).includes('pw'));
});

test('unpairing revokes the token', async () => {
  assert.equal((await call('/v1/unpair', { method: 'POST', token })).status, 200);
  assert.equal((await call('/v1/accounts', { token })).status, 401);
});
