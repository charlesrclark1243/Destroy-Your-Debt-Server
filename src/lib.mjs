// Destroy Your Debt server: shared pieces, kept separate so they can be unit-tested.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 47317;
export const DEFAULT_ORIGINS = ['https://destroy-your-debt.com', 'http://localhost:4200'];
/** Serve cached balances for this long before asking SimpleFIN again. */
export const CACHE_MS = 6 * 60 * 60 * 1000;
/** Even when asked to refresh, don't hit SimpleFIN more often than this (its limit is ~24 requests/day). */
export const MIN_REFRESH_MS = 15 * 60 * 1000;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const MAX_PAIRING_ATTEMPTS = 5;

// ---- config file (holds the SimpleFIN Access URL, which is a password) ----

export function configDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'destroy-your-debt-server');
}

export function configPath(env = process.env) {
  return join(configDir(env), 'config.json');
}

export function loadConfig(env = process.env) {
  const path = configPath(env);
  if (!existsSync(path)) return { accessUrl: null, tokens: [] };
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return { accessUrl: raw.accessUrl ?? null, tokens: Array.isArray(raw.tokens) ? raw.tokens : [] };
}

/** Writes the config readable only by the current user (0600, in a 0700 folder). */
export function saveConfig(config, env = process.env) {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = configPath(env);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// ---- SimpleFIN ----

/** Decodes a setup token into its claim URL, refusing anything that isn't HTTPS. */
export function claimUrlFromSetupToken(token) {
  const clean = String(token).trim();
  if (!/^[A-Za-z0-9+/=_-]+$/.test(clean)) throw new Error('That does not look like a SimpleFIN setup token.');
  const url = Buffer.from(clean, 'base64').toString('utf8').trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('That does not look like a SimpleFIN setup token.');
  }
  if (parsed.protocol !== 'https:') throw new Error('The setup token must point to an https:// address.');
  return parsed.toString();
}

/** Exchanges a setup token for the long-lived Access URL (works once per token). */
export async function claimAccessUrl(setupToken, fetchImpl = fetch) {
  const claimUrl = claimUrlFromSetupToken(setupToken);
  const res = await fetchImpl(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' } });
  const body = (await res.text()).trim();
  if (res.status === 403) throw new Error('SimpleFIN refused the token. It may have been used already; create a new one.');
  if (!res.ok) throw new Error(`SimpleFIN returned HTTP ${res.status} when claiming the token.`);
  const access = new URL(body);
  if (access.protocol !== 'https:' && !isLoopback(access.hostname)) throw new Error('SimpleFIN returned an unexpected Access URL.');
  return access.toString().replace(/\/$/, '');
}

/** Fetches balances (no transactions) and returns them in the dashboard's shape. */
export async function fetchBalances(accessUrl, fetchImpl = fetch) {
  const url = new URL(accessUrl);
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  const base = url.toString().replace(/\/$/, '');
  const res = await fetchImpl(`${base}/accounts?version=2&balances-only=1`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') },
  });
  if (res.status === 403 || res.status === 401) {
    throw Object.assign(new Error('SimpleFIN rejected the saved access. Run "npm run setup" again with a new setup token.'), { code: 'revoked' });
  }
  if (!res.ok) throw new Error(`SimpleFIN returned HTTP ${res.status}.`);
  return normalizeAccountSet(await res.json());
}

/** Turns a SimpleFIN Account Set into plain numbers and bank names. */
export function normalizeAccountSet(set) {
  const connections = new Map((set.connections ?? []).map((c) => [c.conn_id, c]));
  const accounts = (set.accounts ?? []).map((a) => {
    const conn = connections.get(a.conn_id);
    const org = a.org?.name ?? conn?.org_name ?? conn?.name ?? '';
    const date = Number(a['balance-date']);
    return {
      id: String(a.id),
      name: String(a.name ?? ''),
      org: String(org),
      balance: toNumber(a.balance),
      available: a['available-balance'] == null ? null : toNumber(a['available-balance']),
      balanceDate: Number.isFinite(date) && date > 0 ? date * 1000 : null,
      currency: String(a.currency ?? 'USD'),
    };
  });
  const errors = [...(set.errlist ?? []).map((e) => e?.msg ?? String(e)), ...(set.errors ?? []).map(String)];
  return { accounts, errors };
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---- pairing and tokens ----

export function newPairingCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function tokenMatches(token, hashes) {
  const h = Buffer.from(hashToken(token), 'hex');
  return hashes.some((stored) => {
    const s = Buffer.from(stored, 'hex');
    return s.length === h.length && timingSafeEqual(s, h);
  });
}

// ---- request checks ----

export function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

/** Blocks DNS-rebinding: the Host header must name this machine on our port. */
export function hostAllowed(hostHeader, port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(String(hostHeader ?? '').toLowerCase());
}

export function originAllowed(origin, allowed) {
  return typeof origin === 'string' && allowed.includes(origin);
}

export function parseOrigins(value) {
  if (!value) return DEFAULT_ORIGINS;
  return value
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}
