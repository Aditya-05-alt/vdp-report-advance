import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import {
  mapGa4ChannelMatrixRows,
  mapSourceMediumMatrixRows,
  toMappingMap,
} from '@/lib/sourceMapping/apply';
import { loadSourceMapping } from '@/lib/sourceMapping/store';

export const maxDuration = 120;

/**
 * All-dealer channel matrix.
 * Fast path: daily src/med cache → Source Mapping (2–5s).
 * Fallback: live page_data src/med (correct but slower).
 * Last resort: GA4 channel MVs with name alignment.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from')?.slice(0, 10);
  const to = searchParams.get('to')?.slice(0, 10);
  const pageType = searchParams.get('pageType')?.trim() || 'ALL';
  const conditionRaw = searchParams.get('condition')?.trim() || 'BOTH';
  const condition = ['NEW', 'USED', 'BOTH', 'ALL'].includes(
    conditionRaw.toUpperCase()
  )
    ? conditionRaw.toUpperCase()
    : 'BOTH';
  const clientIds = searchParams
    .getAll('clientId')
    .map((id) => id.trim())
    .filter(Boolean);
  // Opt-in slow accurate path (defaults to cache for speed).
  const preferAccurate = searchParams.get('accurate') === '1';

  if (!from || !to) {
    return NextResponse.json({ error: 'Missing from or to' }, { status: 400 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return NextResponse.json(
      { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured on the server' },
      { status: 503 }
    );
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { max_rows: 20000 },
  });

  let mappingCfg = null;
  try {
    mappingCfg = await loadSourceMapping(supabase);
  } catch (err) {
    console.warn(
      '[all-dealers-channel-matrix] loadSourceMapping failed:',
      err?.message
    );
  }

  const ids = clientIds.length ? clientIds : null;
  const mappingMeta = mappingCfg?.channels?.length
    ? {
        channels: (mappingCfg.channels || []).map((c) => ({
          id: c.id,
          name: c.name,
          color: c.color,
          sortOrder: c.sortOrder,
        })),
      }
    : {};

  if (mappingCfg?.channels?.length) {
    const tryCache = async () => {
      const mapped = await fetchMappedFromCache(
        supabase,
        mappingCfg,
        from,
        to,
        pageType,
        ids
      );
      if (!mapped?.length) return null;
      return {
        data: mapped,
        mapped: true,
        source: 'src_med_cache',
        ...mappingMeta,
      };
    };

    // accurate=1: live page_data (slow, Overview-exact). Default stays on cache.
    if (preferAccurate) {
      try {
        const mapped = await fetchMappedFromPageData(
          supabase,
          mappingCfg,
          from,
          to,
          pageType,
          ids
        );
        if (mapped?.length) {
          return NextResponse.json({
            data: mapped,
            mapped: true,
            source: 'page_data_src_med',
            ...mappingMeta,
          });
        }
      } catch (err) {
        console.warn(
          '[all-dealers-channel-matrix] accurate page_data path failed:',
          err?.message
        );
      }
    }

    try {
      const out = await tryCache();
      if (out) return NextResponse.json(out);
    } catch (err) {
      console.warn(
        '[all-dealers-channel-matrix] cache src/med path failed:',
        err?.message
      );
    }
    // Do NOT fall back to live page_data automatically — it is 30–40s and
    // made compare (prior month) feel broken when cache was empty.
  }

  // ── Last resort: GA4 channel MVs (name-align only) ──
  const rpcParams = {
    p_from: from,
    p_to: to,
    p_page_type: pageType,
    p_client_ids: ids,
    p_condition: condition === 'ALL' ? 'BOTH' : condition,
  };

  const { data, error } = await supabase.rpc(
    'get_all_dealers_channel_matrix_advance',
    rpcParams
  );

  if (error) {
    console.error(
      '[all-dealers-channel-matrix-advance]',
      error.message,
      clientIds.length ? `chunk=${clientIds.length}` : 'all'
    );
    const hint = /mv_ga4_channel|does not exist|schema cache/i.test(
      error.message || ''
    )
      ? ' Ensure mv_ga4_channel_daily / monthly / yearly exist and get_all_dealers_channel_matrix_advance is deployed. Refresh MVs after GA4 sync.'
      : '';
    return NextResponse.json({ error: error.message + hint }, { status: 500 });
  }

  let rows = data ?? [];
  try {
    if (mappingCfg?.channels?.length) {
      rows = mapGa4ChannelMatrixRows(rows, mappingCfg.channels);
    }
  } catch (err) {
    console.warn(
      '[all-dealers-channel-matrix] mapping align skipped:',
      err?.message
    );
  }

  return NextResponse.json({
    data: rows,
    mapped: Boolean(mappingCfg?.channels?.length),
    source: 'mv',
  });
}

const RPC_PAGE = 1000;

async function rpcAll(supabase, fn, args) {
  const all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .rpc(fn, args)
      .range(from, from + RPC_PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = data || [];
    all.push(...batch);
    if (batch.length < RPC_PAGE) break;
    from += RPC_PAGE;
  }
  return all;
}

function applyMapping(rawRows, mappingCfg) {
  if (!rawRows?.length) return [];
  const mapping = toMappingMap(mappingCfg.mapping || mappingCfg.rules);
  return mapSourceMediumMatrixRows(rawRows, mappingCfg.channels, mapping);
}

async function fetchMappedFromPageData(
  supabase,
  mappingCfg,
  from,
  to,
  pageType,
  clientIds
) {
  const rawRows = await rpcAll(
    supabase,
    'get_all_dealers_source_medium_matrix_advance',
    {
      p_from: from,
      p_to: to,
      p_page_type: pageType,
      p_client_ids: clientIds,
    }
  );
  return applyMapping(rawRows, mappingCfg);
}

async function fetchMappedFromCache(
  supabase,
  mappingCfg,
  from,
  to,
  pageType,
  clientIds
) {
  const rawRows = await rpcAll(
    supabase,
    'get_all_dealers_src_med_cache_matrix_advance',
    {
      p_from: from,
      p_to: to,
      p_page_type: pageType,
      p_client_ids: clientIds,
    }
  );
  return applyMapping(rawRows, mappingCfg);
}
