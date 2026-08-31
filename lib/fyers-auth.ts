const STATE_COOKIE = 'oi_fyers_state';
const SESSION_COOKIE = 'oi_fyers_session';
const CREDENTIALS_COOKIE = 'oi_fyers_credentials';
const FIFTEEN_MINUTES = 15 * 60;
const ONE_DAY = 24 * 60 * 60;
const THIRTY_DAYS = 30 * ONE_DAY;
// Local development can operate without configuration, but its encrypted
// cookies intentionally expire whenever the server restarts. Set
// OI_COOKIE_SECRET to a long random value to retain them across restarts.
const EPHEMERAL_COOKIE_SECRET = randomBase64Url(32);

interface FyersCredentials {
  appId: string;
  secretId: string;
}

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

function environmentCredentials(): FyersCredentials | null {
  const appId = process.env.FYERS_APP_ID?.trim();
  const secretId = process.env.FYERS_SECRET_ID?.trim();
  return appId && secretId ? { appId, secretId } : null;
}

function apiBase() {
  return process.env.FYERS_API_BASE?.trim() || 'https://api-t1.fyers.in';
}

export async function readFyersCredentials(request: Request): Promise<FyersCredentials | null> {
  const environment = environmentCredentials();
  if (environment) return environment;
  const sealed = readCookie(request, CREDENTIALS_COOKIE);
  if (!sealed) return null;
  try {
    return await openValue<FyersCredentials>(sealed, await credentialKey(request));
  } catch {
    return null;
  }
}

export async function fyersIsConfigured(request: Request) {
  return Boolean(await readFyersCredentials(request));
}

export function fyersRedirectUri(request: Request) {
  const explicit = process.env.FYERS_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const siteUrl = process.env.SITE_URL?.trim();
  return new URL('/api/auth/fyers/callback', siteUrl || request.url).toString();
}

export async function createFyersLogin(request: Request) {
  const credentials = await readFyersCredentials(request);
  if (!credentials) throw new Error('Enter your FYERS App ID and Secret ID in Setup first.');
  const state = randomBase64Url(24);
  const url = new URL('/api/v3/generate-authcode', apiBase());
  url.searchParams.set('client_id', credentials.appId);
  url.searchParams.set('redirect_uri', fyersRedirectUri(request));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return { url, state };
}

export async function exchangeFyersAuthCode(request: Request, code: string) {
  const credentials = await readFyersCredentials(request);
  if (!credentials) throw new Error('FYERS credentials are missing.');
  const appIdHash = await sha256Hex(`${credentials.appId}:${credentials.secretId}`);
  const response = await fetch(new URL('/api/v3/validate-authcode', apiBase()), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'OI-Lens/1.0 FYERS-API-Client',
    },
    body: JSON.stringify({ grant_type: 'authorization_code', appIdHash, code }),
  });
  const body = await response.text();
  const payload = parseJson<FyersTokenResponse>(body);
  if (!payload) {
    throw new Error(`FYERS authentication returned an unexpected response (${response.status}).`);
  }
  if (!response.ok || payload.s === 'error' || !payload.access_token) {
    throw new Error(payload.message ?? `FYERS token exchange failed (${response.status}).`);
  }
  return sealValue(
    { accessToken: payload.access_token, refreshToken: payload.refresh_token, connectedAt: new Date().toISOString() },
    await sessionKey(request, credentials.secretId),
  );
}

export async function readFyersAuthorization(request: Request) {
  const sealed = readCookie(request, SESSION_COOKIE);
  const credentials = await readFyersCredentials(request);
  if (!sealed || !credentials) return null;
  try {
    const session = await openValue<FyersSession>(sealed, await sessionKey(request, credentials.secretId));
    return `${credentials.appId}:${session.accessToken}`;
  } catch {
    return null;
  }
}

export async function hasFyersSession(request: Request) {
  return Boolean(await readFyersAuthorization(request));
}

export async function credentialsCookie(request: Request, credentials: FyersCredentials) {
  const sealed = await sealValue(credentials, await credentialKey(request));
  return serializeCookie(CREDENTIALS_COOKIE, sealed, request, THIRTY_DAYS);
}

export function readFyersState(request: Request) {
  return readCookie(request, STATE_COOKIE);
}

export function stateCookie(request: Request, state: string) {
  return serializeCookie(STATE_COOKIE, state, request, FIFTEEN_MINUTES);
}

export function sessionCookie(request: Request, sealed: string) {
  return serializeCookie(SESSION_COOKIE, sealed, request, ONE_DAY);
}

export function clearFyersSessionCookies(request: Request) {
  return [clearCookie(STATE_COOKIE, request), clearCookie(SESSION_COOKIE, request)];
}

export function clearAllFyersCookies(request: Request) {
  return [...clearFyersSessionCookies(request), clearCookie(CREDENTIALS_COOKIE, request)];
}

function readCookie(request: Request, name: string) {
  const header = request.headers.get('cookie') ?? '';
  for (const item of header.split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function serializeCookie(name: string, value: string, request: Request, maxAge: number) {
  const secure = new URL(request.url).protocol === 'https:' || process.env.NODE_ENV === 'production';
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? '; Secure' : ''}; HttpOnly`;
}

function clearCookie(name: string, request: Request) {
  return serializeCookie(name, '', request, 0);
}

async function sealValue(value: unknown, key: CryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv);
  combined.set(encrypted, iv.length);
  return toBase64Url(combined);
}

async function openValue<T>(value: string, key: CryptoKey): Promise<T> {
  const combined = fromBase64Url(value);
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

async function credentialKey(request: Request) {
  const userId = request.headers.get('oai-authenticated-user-id') || 'oi-lens-local-user';
  return aesKey(`${cookieSecret()}:${userId}:oi-lens-fyers-credentials`);
}

async function sessionKey(request: Request, secretId: string) {
  const userId = request.headers.get('oai-authenticated-user-id') || 'oi-lens-local-user';
  return aesKey(`${cookieSecret()}:${userId}:${secretId}:oi-lens-session`);
}

function cookieSecret() {
  return process.env.OI_COOKIE_SECRET?.trim() || EPHEMERAL_COOKIE_SECRET;
}

async function aesKey(material: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
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
