// Isolated synthetic-cookie smoke check. No real broker credentials or login.
import assert from 'node:assert/strict';

const base = process.argv[2];
if (!base) throw new Error('Usage: node scripts/check_fyers_persistence.mjs https://your-site');
const jar = new Map();
async function call(path, options = {}) {
  const response = await fetch(new URL(path, base), {
    ...options, redirect: 'manual',
    headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...options.headers },
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0];
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    if (/Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name);
    else jar.set(name, pair.slice(separator + 1));
  }
  return response;
}
const synthetic = { appId: 'TEST-ONLY-100', secretId: 'synthetic-credentials-not-a-real-account' };
const save = await call('/api/auth/fyers/setup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(synthetic),
});
assert.equal(save.status, 200, 'Setup must save successfully');
const credential = save.headers.getSetCookie().find(c => c.startsWith('oi_fyers_credentials='));
assert.ok(credential?.includes('Max-Age=31536000'));
assert.ok(credential.includes('HttpOnly') && credential.includes('Secure'));
assert.ok(!credential.includes(synthetic.secretId));
assert.deepEqual(await (await call('/api/auth/fyers/status')).json(), { configured: true, connected: false });
assert.equal((await call('/api/auth/fyers/logout', { method: 'POST' })).status, 200);
assert.deepEqual(await (await call('/api/auth/fyers/status')).json(), { configured: true, connected: false });
const login = await call('/api/auth/fyers/login');
assert.equal(login.status, 302);
assert.equal(new URL(login.headers.get('location')).searchParams.get('client_id'), synthetic.appId);
// Do not follow the broker redirect. A failed callback must also retain setup.
assert.equal((await call('/api/auth/fyers/callback?state=invalid')).status, 302);
assert.deepEqual(await (await call('/api/auth/fyers/status')).json(), { configured: true, connected: false });
assert.equal((await call('/api/auth/fyers/setup', { method: 'DELETE' })).status, 200);
assert.deepEqual(await (await call('/api/auth/fyers/status')).json(), { configured: false, connected: false });
console.log('PASS: encrypted one-year setup, renewal, disconnect, reconnect redirect, failed callback, and Forget.');
