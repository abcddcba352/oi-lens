import {
  clearFyersSessionCookies,
  exchangeFyersAuthCode,
  fyersRedirectUri,
  readFyersState,
  sessionCookie,
} from '@/lib/fyers-auth';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnUrl = new URL('/', fyersRedirectUri(request));
  const code = url.searchParams.get('auth_code') ?? url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = readFyersState(request);
  if (!code || !state || !expectedState || state !== expectedState) {
    returnUrl.searchParams.set('fyers', 'failed');
    return redirectWithCookies(returnUrl, clearFyersSessionCookies(request));
  }
  try {
    const sealed = await exchangeFyersAuthCode(request, code);
    returnUrl.searchParams.set('fyers', 'connected');
    return redirectWithCookies(returnUrl, [sessionCookie(request, sealed), ...clearFyersSessionCookies(request).slice(0, 1)]);
  } catch (error) {
    console.error('FYERS token exchange failed:', error instanceof Error ? error.message : 'Unknown error');
    returnUrl.searchParams.set('fyers', 'failed');
    return redirectWithCookies(returnUrl, clearFyersSessionCookies(request));
  }
}

function redirectWithCookies(url: URL, cookies: string[]) {
  const headers = new Headers({ Location: url.toString(), 'Cache-Control': 'no-store' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}
