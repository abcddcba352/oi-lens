import {
  clearFyersCookies,
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
    return redirectWithCookies(returnUrl, clearFyersCookies(request));
  }
  try {
    const sealed = await exchangeFyersAuthCode(code);
    returnUrl.searchParams.set('fyers', 'connected');
    return redirectWithCookies(returnUrl, [sessionCookie(request, sealed), ...clearFyersCookies(request).slice(0, 1)]);
  } catch {
    returnUrl.searchParams.set('fyers', 'failed');
    return redirectWithCookies(returnUrl, clearFyersCookies(request));
  }
}

function redirectWithCookies(url: URL, cookies: string[]) {
  const headers = new Headers({ Location: url.toString(), 'Cache-Control': 'no-store' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}
