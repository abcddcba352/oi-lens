import { clearAllFyersCookies, credentialsCookie, fyersRedirectUri, randomBase64Url, stateCookie } from '@/lib/fyers-auth';

const APP_ID = /^[A-Za-z0-9_-]{6,80}$/;

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as { appId?: string; secretId?: string } | null;
  const appId = payload?.appId?.trim() ?? '';
  const secretId = payload?.secretId?.trim() ?? '';
  if (!APP_ID.test(appId) || secretId.length < 8 || secretId.length > 200) {
    return Response.json({ error: 'Enter a valid FYERS App ID and Secret ID.' }, { status: 400 });
  }

  const state = randomBase64Url(24);
  const apiBase = globalThis.process?.env?.FYERS_API_BASE?.trim() || 'https://api-t1.fyers.in';
  const loginUrl = new URL('/api/v3/generate-authcode', apiBase);
  loginUrl.searchParams.set('client_id', appId);
  loginUrl.searchParams.set('redirect_uri', fyersRedirectUri(request));
  loginUrl.searchParams.set('response_type', 'code');
  loginUrl.searchParams.set('state', state);

  const headers = new Headers({ 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', await credentialsCookie(request, { appId, secretId }));
  headers.append('Set-Cookie', stateCookie(request, state));
  return Response.json({ configured: true, connected: false, loginUrl: loginUrl.toString() }, { headers });
}

export async function DELETE(request: Request) {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const cookie of clearAllFyersCookies(request)) headers.append('Set-Cookie', cookie);
  return Response.json({ configured: false, connected: false }, { headers });
}
