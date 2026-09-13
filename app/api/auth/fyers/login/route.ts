import { createFyersLogin, stateCookie, renewCredentialsCookie, clearFyersSessionCookies } from '@/lib/fyers-auth';

export async function GET(request: Request) {
  try {
    const { url, state } = await createFyersLogin(request);
    const headers = new Headers({ Location: url.toString(), 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', clearFyersSessionCookies(request)[1]);
    headers.append('Set-Cookie', stateCookie(request, state));
    const renewed = await renewCredentialsCookie(request);
    if (renewed) headers.append('Set-Cookie', renewed);
    return new Response(null, {
      status: 302,
      headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'FYERS login is unavailable.';
    return Response.json({ error: message }, { status: 503 });
  }
}
