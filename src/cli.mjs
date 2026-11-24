#!/usr/bin/env node
// Destroy Your Debt server: a local companion for the Destroy Your Debt dashboard.
//
// Keeps your SimpleFIN Access URL on this computer and serves card balances
// to the dashboard over 127.0.0.1 only. See README.md.
//
//   npm run setup     paste a SimpleFIN setup token (one time)
//   npm start         start the server (prints a pairing code)
//   npm run status    show what's saved
//   npm run forget    delete the saved access and pairings

import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  CACHE_MS,
  DEFAULT_PORT,
  MAX_PAIRING_ATTEMPTS,
  MIN_REFRESH_MS,
  PAIRING_TTL_MS,
  claimAccessUrl,
  configPath,
  fetchBalances,
  hashToken,
  hostAllowed,
  loadConfig,
  newPairingCode,
  newToken,
  originAllowed,
  parseOrigins,
  saveConfig,
  tokenMatches,
} from './lib.mjs';

const command = process.argv[2] ?? 'serve';

if (command === 'setup') await setup();
else if (command === 'serve') await serve();
else if (command === 'status') status();
else if (command === 'forget') forget();
else {
  console.error(`Unknown command "${command}". Use: setup, serve, status or forget.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

async function setup() {
  console.log('Paste your SimpleFIN setup token (create one at https://bridge.simplefin.org/simplefin/create).');
  console.log('It is used once and not shown on screen.\n');
  const token = await readSecret('Setup token: ');
  if (!token) fail('No token entered.');
  let accessUrl;
  try {
    accessUrl = await claimAccessUrl(token);
  } catch (e) {
    fail(e.message);
  }
  const config = loadConfig();
  saveConfig({ ...config, accessUrl });
  console.log(`\nSaved. The access details are in ${configPath()} (readable only by you).`);
  try {
    const { accounts, errors } = await fetchBalances(accessUrl);
    console.log(`Connected: ${accounts.length} account(s) found:`);
    for (const a of accounts) console.log(`  - ${a.org ? a.org + ': ' : ''}${a.name}`);
    for (const e of errors) console.log(`  ! ${e}`);
  } catch (e) {
    console.log(`Saved, but the test request failed: ${e.message}`);
  }
  console.log('\nNext: run "npm start" and pair the dashboard with the code it prints.');
}

async function serve() {
  const port = Number(process.env.DYD_PORT || DEFAULT_PORT);
  const origins = parseOrigins(process.env.DYD_ORIGINS);
  let config = loadConfig();
  if (!config.accessUrl) fail('No SimpleFIN access saved yet. Run "npm run setup" first.');

  let pairing = { code: newPairingCode(), expires: Date.now() + PAIRING_TTL_MS, attempts: 0 };
  let cache = null; // { at, data }
  let inFlight = null;

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (status, body) => {
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
      if (originAllowed(origin, origins)) headers['Access-Control-Allow-Origin'] = origin;
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };

    // Only this computer, only the dashboard's own sites.
    if (!hostAllowed(req.headers.host, port)) return send(403, { error: 'Bad host.' });
    if (!originAllowed(origin, origins)) return send(403, { error: 'This site is not allowed to use the Destroy Your Debt server.' });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        // Chrome's local-network checks for public sites calling 127.0.0.1:
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      return res.end();
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const paired = !!token && tokenMatches(token, config.tokens.map((t) => t.hash));

    try {
      if (req.method === 'GET' && url.pathname === '/v1/status') {
        return send(200, { app: 'destroy-your-debt-server', version: 1, linked: !!config.accessUrl, paired });
      }

      if (req.method === 'POST' && url.pathname === '/v1/pair') {
        const body = await readJson(req);
        if (!pairing || Date.now() > pairing.expires) {
          return send(410, { error: 'The pairing code has expired. Restart the server for a new one.' });
        }
        if (String(body.code ?? '').replace(/\D/g, '') !== pairing.code) {
          pairing.attempts++;
          if (pairing.attempts >= MAX_PAIRING_ATTEMPTS) {
            pairing = null;
            console.log('Too many wrong pairing codes. Restart the server for a new one.');
            return send(429, { error: 'Too many wrong codes. Restart the server for a new one.' });
          }
          return send(401, { error: 'That pairing code is not right.' });
        }
        const newT = newToken();
        config = { ...config, tokens: [...config.tokens, { hash: hashToken(newT), origin, createdAt: new Date().toISOString() }] };
        saveConfig(config);
        pairing = null;
        console.log(`Paired with ${origin}.`);
        return send(200, { token: newT });
      }

      if (!paired) return send(401, { error: 'Not paired. Enter the pairing code shown by the server.' });

      if (req.method === 'GET' && url.pathname === '/v1/accounts') {
        const wantRefresh = url.searchParams.get('refresh') === '1';
        const age = cache ? Date.now() - cache.at : Infinity;
        const useCache = cache && (age < (wantRefresh ? MIN_REFRESH_MS : CACHE_MS));
        if (!useCache) {
          inFlight ??= fetchBalances(config.accessUrl).finally(() => (inFlight = null));
          cache = { at: Date.now(), data: await inFlight };
          console.log(`Fetched ${cache.data.accounts.length} account(s) from SimpleFIN.`);
        }
        return send(200, { fetchedAt: cache.at, cached: !!useCache, ...cache.data });
      }

      if (req.method === 'POST' && url.pathname === '/v1/unpair') {
        const h = hashToken(token);
        config = { ...config, tokens: config.tokens.filter((t) => t.hash !== h) };
        saveConfig(config);
        console.log(`Unpaired ${origin}.`);
        return send(200, { ok: true });
      }

      return send(404, { error: 'Not found.' });
    } catch (e) {
      if (e.code === 'revoked') return send(502, { error: e.message, revoked: true });
      return send(502, { error: e.message ?? 'Request failed.' });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Destroy Your Debt server running on http://127.0.0.1:${port}`);
    console.log(`Allowed sites: ${origins.join(', ')}`);
    console.log(`\n  Pairing code: ${pairing.code.slice(0, 3)}-${pairing.code.slice(3)}   (valid 10 minutes, one use)\n`);
    console.log('Enter it in the dashboard under "Bank sync". Already-paired browsers don\'t need it.');
    console.log('Press Ctrl+C to stop.');
  });
}

function status() {
  const config = loadConfig();
  console.log(`Config file: ${configPath()}`);
  console.log(`SimpleFIN access saved: ${config.accessUrl ? 'yes' : 'no'}`);
  console.log(`Paired browsers: ${config.tokens.length}`);
  for (const t of config.tokens) console.log(`  - ${t.origin ?? 'unknown site'} (since ${t.createdAt ?? '?'})`);
}

function forget() {
  rmSync(configPath(), { force: true });
  console.log('Deleted the saved SimpleFIN access and all pairings.');
  console.log('To also revoke it on SimpleFIN\'s side, remove the app connection at bridge.simplefin.org.');
}

// ---------------------------------------------------------------------------

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024) {
        reject(new Error('Request too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** Reads a line without echoing it when typed in a terminal; reads plainly when piped. */
function readSecret(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (process.stdin.isTTY) {
      rl._writeToOutput = (s) => {
        if (s.includes(prompt)) process.stdout.write(prompt);
      };
    }
    rl.question(prompt, (answer) => {
      rl.close();
      if (process.stdin.isTTY) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}
