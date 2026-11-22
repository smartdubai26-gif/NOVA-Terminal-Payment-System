// Supabase Edge Function: refresh-asset-rates
// Fetches spot USD rates for BTC, ETH, and USDT from CoinGecko and updates
// `public.asset_rates` atomically via `public.refresh_asset_rates` RPC.
//
// Deploy: supabase functions deploy refresh-asset-rates
// Schedule: invoke via Supabase pg_cron / Scheduled Functions every 1-5 minutes.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,tether&vs_currencies=usd&include_24hr_change=true';

interface CoinGeckoPriceEntry {
  usd?: number;
  usd_24h_change?: number;
}

interface CoinGeckoResponse {
  bitcoin?: CoinGeckoPriceEntry;
  ethereum?: CoinGeckoPriceEntry;
  tether?: CoinGeckoPriceEntry;
}

async function timingSafeBearerMatch(
  headerValue: string | null,
  expectedSecret: string
): Promise<boolean> {
  if (!headerValue) return false;
  const prefix = 'Bearer ';
  if (!headerValue.startsWith(prefix)) return false;
  const provided = headerValue.slice(prefix.length);

  const enc = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(provided)),
    crypto.subtle.digest('SHA-256', enc.encode(expectedSecret)),
  ]);
  const aBytes = new Uint8Array(aHash);
  const bBytes = new Uint8Array(bHash);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < aBytes.length; i += 1) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  try {
    const cronSecret = Deno.env.get('RATE_REFRESH_SECRET')?.trim();
    if (!cronSecret) {
      return new Response(
        JSON.stringify({ error: 'RATE_REFRESH_SECRET is not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const authorized = await timingSafeBearerMatch(
      req.headers.get('authorization'),
      cronSecret
    );
    if (!authorized) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const cgRes = await fetch(COINGECKO_URL, {
      headers: { Accept: 'application/json' },
    });
    if (!cgRes.ok) {
      return new Response(
        JSON.stringify({ error: `CoinGecko upstream HTTP ${cgRes.status}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const payload = (await cgRes.json()) as CoinGeckoResponse;
    const btcUsd = Number(payload.bitcoin?.usd);
    const ethUsd = Number(payload.ethereum?.usd);
    const usdtUsd = Number(payload.tether?.usd ?? 1.0);

    if (
      !Number.isFinite(btcUsd) ||
      btcUsd <= 0 ||
      !Number.isFinite(ethUsd) ||
      ethUsd <= 0 ||
      !Number.isFinite(usdtUsd) ||
      usdtUsd <= 0
    ) {
      return new Response(
        JSON.stringify({ error: 'Invalid spot price payload received from CoinGecko' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data, error } = await supabase.rpc('refresh_asset_rates', {
      p_btc_usd: btcUsd,
      p_eth_usd: ethUsd,
      p_usdt_usd: usdtUsd,
      p_source: 'coingecko',
      p_btc_change_24h: Number(payload.bitcoin?.usd_24h_change ?? 0),
      p_eth_change_24h: Number(payload.ethereum?.usd_24h_change ?? 0),
      p_usdt_change_24h: Number(payload.tether?.usd_24h_change ?? 0),
    });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected rate refresh failure';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
