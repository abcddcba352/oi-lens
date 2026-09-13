import test from 'node:test';
import assert from 'node:assert/strict';
import {
  credentialsCookie, readFyersCredentials, renewCredentialsCookie,
  exchangeFyersAuthCode, readFyersAuthorization, sessionCookie,
  clearFyersSessionCookies, clearAllFyersCookies, createFyersLogin,
} from '../lib/fyers-auth.ts';

const base = 'https://oi-lens.example';
const fake = { appId: 'TEST-APP-100', secretId: 'test-only-not-real-credentials' };
function request(cookies: string[] = []) {
  return new Request(base, { headers: { cookie: cookies.map(c => c.split(';')[0]).join('; ') } });
}

test('FYERS saved credentials survive session expiry and renew for a year', async (t) => {
  delete process.env.FYERS_APP_ID;
  delete process.env.FYERS_SECRET_ID;
  process.env.OI_COOKIE_SECRET = 'test-persistent-server-encryption-secret';
  const saved = await credentialsCookie(request(), fake);
  assert.match(saved, /Max-Age=31536000/);
  assert.match(saved, /HttpOnly/);
  assert.match(saved, /Secure/);
  assert.match(saved, /SameSite=Lax/);
  assert.ok(!saved.includes(fake.secretId));
  assert.ok(!saved.includes(fake.appId));
  const withSaved = request([saved]);
  assert.deepEqual(await readFyersCredentials(withSaved), fake);
  assert.equal(await readFyersAuthorization(withSaved), null);

  const connectedAt = Date.now();
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(connectedAt / 1000) + 3600 })).toString('base64url')}.signature`;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ s: 'ok', access_token: token }));
  const sealed = await exchangeFyersAuthCode(withSaved, 'fake-code');
  const connected = request([saved, sessionCookie(withSaved, sealed)]);
  assert.equal(await readFyersAuthorization(connected), `${fake.appId}:${token}`);
  t.mock.method(Date, 'now', () => connectedAt + 2 * 3600000);
  assert.equal(await readFyersAuthorization(connected), null, 'broker expiry wins over cookie expiry');
  t.mock.method(Date, 'now', () => connectedAt + 2 * 86400000);
  assert.deepEqual(await readFyersCredentials(connected), fake, 'daily expiry must not clear setup');
  const renewed = await renewCredentialsCookie(connected);
  assert.ok(renewed);
  assert.match(renewed, /Max-Age=31536000/);
  const login = await createFyersLogin(request([renewed]));
  assert.equal(login.url.searchParams.get('client_id'), fake.appId);
  assert.equal(login.url.searchParams.get('redirect_uri'), `${base}/api/auth/fyers/callback`);
});

test('disconnect preserves saved setup, while Forget clears it', () => {
  const disconnect = clearFyersSessionCookies(request());
  assert.equal(disconnect.length, 2);
  assert.ok(disconnect.every(c => !c.startsWith('oi_fyers_credentials=')));
  const forget = clearAllFyersCookies(request());
  assert.ok(forget.some(c => c.startsWith('oi_fyers_credentials=') && c.includes('Max-Age=0')));
});

test('invalid cookies are treated as missing credentials', async () => {
  assert.equal(await readFyersCredentials(request(['oi_fyers_credentials=%malformed'])), null);
  assert.equal(await readFyersCredentials(request(['oi_fyers_credentials=garbage'])), null);
  assert.equal(await renewCredentialsCookie(request()), null);
});

test('production refuses to encrypt saved credentials using a public fallback', async () => {
  const originalEnv = process.env.NODE_ENV;
  const originalSecret = process.env.OI_COOKIE_SECRET;
  try {
    Reflect.set(process.env, 'NODE_ENV', 'production');
    delete process.env.OI_COOKIE_SECRET;
    await assert.rejects(credentialsCookie(request(), fake), /OI_COOKIE_SECRET/);
  } finally {
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
    else Reflect.set(process.env, 'NODE_ENV', originalEnv);
    if (originalSecret === undefined) delete process.env.OI_COOKIE_SECRET;
    else process.env.OI_COOKIE_SECRET = originalSecret;
  }
});
