import { clearFyersSessionCookies } from '@/lib/fyers-auth';

export async function POST(request: Request) {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const cookie of clearFyersSessionCookies(request)) headers.append('Set-Cookie', cookie);
  return Response.json({ connected: false }, { headers });
}
