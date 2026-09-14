import { env } from 'cloudflare:workers';
import { readForwardLedger } from '@/lib/forward-test-store';

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    // Both published copies read one authoritative ledger. No credentials or request
    // headers are forwarded, and no public write endpoint is exposed.
    if (new URL(request.url).hostname.endsWith('.chatgpt.site')) {
      const response = await fetch(
        'https://oi-lens.kodidalanani.workers.dev/api/market/forward-test',
        {
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        },
      );
      return Response.json(await response.json(), { status: response.status, headers });
    }
    return Response.json(await readForwardLedger(env.DB), { headers });
  } catch (error) {
    console.error('Forward ledger read failed', error);
    const quota = /7500|row.*read.*limit|daily.*limit/i.test(String(error));
    return Response.json(
      {
        error: quota
          ? 'Cloudflare’s daily database quota is exhausted. It resets at 05:30 IST; the ledger retry is scheduled for 05:40 IST on weekdays. New signals are not confirmed until a recording run succeeds.'
          : 'Forward tracking is unavailable. Check the daily updater; existing records have not been replaced.',
      },
      { status: 503, headers },
    );
  }
}
