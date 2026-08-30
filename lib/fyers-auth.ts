const STATE_COOKIE = 'oi_fyers_state';
const SESSION_COOKIE = 'oi_fyers_session';
const FIFTEEN_MINUTES = 15 * 60;
const ONE_DAY = 24 * 60 * 60;

interface FyersTokenResponse {
  s?: string;
  code?: number;
  message?: string;
  access_token?: string;
  refresh_token?: string;
}

interface FyersSession {
  accessToken: string;
  refreshToken?: string;
  connectedAt: string;
}

function appId() {
  return process.env.FYERS_APP_ID?.trim() ?? '';
}

function secretId() {
  return process.env.FYERS_SECRET_ID?.trim() ?? '';
}

function apiBase() {
  return process.env.FYERS_API_BASE?.trim() || 'https://api-t1.fyers.in';
}

export function fyersIsConfigured() {
  return Boolean(appId() && secretId());
}

export function fyersRedirectUri(request: Request) {
  const explicit = process.env.FYERS_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const siteUrl = process.env.SITE_URL?.trim();
  return new URL('/api/auth/fyers/callback', siteUrl || request.url).toString();
}

export function createFyersLogin(request: Request) {
  if (!fyersIsConfigured()) throw new Error('FYERS App ID and Secret ID are not configured yet.');
  const state = randomBase64Url(24);
  const url = new URL('/api/v3/generate-authcode', apiBase());
  url.searchParams.set('client_id', appId());
  url.searchParams.set('redirect_uri', fyersRedirectUri(request));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return { url, state };
}

export async function exchangeFyersAuthCode(code: string) {
  const appIdHash = await sha256Hex(`${appId()}${secretId()}`);
  const response = await fetch(new URL('/api/v3/validate-authcode', apiBase()), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', appIdHash, code }),
  });
  const payload = (await response.json()) as FyersTokenResponse;
  if (!response.ok || payload.s === 'error' || !payload.access_token) {
    throw new Error(payload.message ?? `FYERS token exchange failed (${response.status}).`);
  }
  return sealSession({
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    connectedAt: new Date().toISOString(),
  });
}

export async function readFyersAuthorization(request: Request) {
  const sealed = readCookie(request, SESSION_COOKIE);
  if (!sealed || !fyersIsConfigured()) return null;
  try {
    const session = await openSession(sealed);
    return `${appId()}:${session.accessToken}`;
  } catch {
    return null;
  }
}

export async function hasFyersSession(request: Request) {
  return Boolean(await readFyersAuthorization(request));
}

export function readFyersState(request: Request) {
  return readCookie(request, STATE_COOKIE);
}

export function stateCookie(request: Request, state: string) {
  return serializeCookie(STATE_COOKIE, state, request, FIFTEEN_MINUTES, true);
}

export function sessionCookie(request: Request, sealed: string) {
  return serializeCookie(SESSION_COOKIE, sealed, request, ONE_DAY, true);
}

export function clearFyersCookies(request: Request) {
  return [
    serializeCookie(STATE_COOKIE, '', request, 0, true),
    serializeCookie(SESSION_COOKIE, '', request, 0, true),
  ];
}

function readCookie(request: Request, name: string) {
  const header = request.headers.get('cookie') ?? '';
  for (const item of header.split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function serializeCookie(name: string, value: string, request: Request, maxAge: number, httpOnly: boolean) {
  const secure = new URL(request.url).protocol === 'https:' || process.env.NODE_ENV === 'production';
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? '; Secure' : ''}${httpOnly ? '; HttpOnly' : ''}`;
}

async function sealSession(session: FyersSession) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sessionKey();
  const plaintext = new TextEncoder().encode(JSON.stringify(session));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv);
  combined.set(encrypted, iv.length);
  return toBase64Url(combined);
}

async function openSession(value: string): Promise<FyersSession> {
  const combined = fromBase64Url(value);
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);
  const key = await sessionKey();
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return JSON.parse(new TextDecoder().decode(plaintext)) as FyersSession;
}

async function sessionKey() {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${secretId()}:oi-lens-session`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomBase64Url(bytes: number) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function toBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
