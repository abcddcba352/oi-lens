import { fyersIsConfigured, hasFyersSession, renewCredentialsCookie } from '@/lib/fyers-auth';

export async function GET(request: Request) {
  const headers = new Headers({ 'Cache-Control': 'no-store, max-age=0' });
  const renewed = await renewCredentialsCookie(request);
  if (renewed) headers.append('Set-Cookie', renewed);
  return Response.json(
    { configured: await fyersIsConfigured(request), connected: await hasFyersSession(request) },
    { headers },
  );
}
