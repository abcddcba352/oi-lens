import { ensureDbSchema, getDb } from '@/db';
import { env } from 'cloudflare:workers';
import { materializeOrFetchWatchlist } from '@/lib/watchlist-materializer';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('horizon') ?? 'short';
  const force = url.searchParams.get('force') === 'true' || url.searchParams.has('refresh');

  if (mode !== 'short' && mode !== 'positional') {
    return Response.json({ error: 'Invalid watchlist horizon.' }, { status: 400 });
  }

  const headers = { 'Cache-Control': 'private, no-store' };

  try {
    await ensureDbSchema();
    const db = getDb();

    // Latest official session date from completed EOD bhavcopy
    const istDate = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const latestOfficial = await env.DB.prepare(
      "SELECT MAX(session_date) AS latest FROM market_sessions WHERE source='nse-bhavcopy' AND session_date<=?",
    ).bind(istDate).first<{ latest: string | null }>();

    const asOf = latestOfficial?.latest ?? new Date(Date.parse(istDate) - 86400000).toISOString().slice(0, 10);

    const payload = await materializeOrFetchWatchlist(db, env.DB, mode, asOf, force);
    return Response.json(payload, { headers });
  } catch (error) {
    console.error('Watchlist scan failed', error);
    return Response.json(
      { error: 'Unable to read stored market history. Refresh or check the daily import.' },
      { status: 503, headers },
    );
  }
}

