import { createFyersLogin, stateCookie } from '@/lib/fyers-auth';

export async function GET(request: Request) {
  try {
    const { url, state } = createFyersLogin(request);
    return new Response(null, {
      status: 302,
      headers: { Location: url.toString(), 'Set-Cookie': stateCookie(request, state), 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'FYERS login is unavailable.';
    return Response.json({ error: message }, { status: 503 });
  }
}
