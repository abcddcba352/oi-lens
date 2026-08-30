import { fyersIsConfigured, hasFyersSession } from '@/lib/fyers-auth';

export async function GET(request: Request) {
  return Response.json(
    { configured: fyersIsConfigured(), connected: await hasFyersSession(request) },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
