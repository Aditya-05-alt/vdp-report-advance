import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

function needsVinEnrichment(rows) {
  if (!rows?.length) return false;
  const hasVinKey = Object.prototype.hasOwnProperty.call(rows[0], 'inv_vin');
  if (!hasVinKey) return true;
  return !rows.some((r) => r.inv_vin && String(r.inv_vin).trim());
}

async function lookupVinByStock(supabase, clientId, stockNumbers) {
  const vinByStock = new Map();
  const unique = [...new Set(stockNumbers.filter(Boolean))];
  const chunkSize = 100;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('smart_final_data')
      .select('inv_stock_number, inv_vin')
      .eq('client_id', clientId)
      .in('inv_stock_number', chunk)
      .not('inv_vin', 'is', null)
      .neq('inv_vin', '');

    if (error) {
      console.error('[inventory-performance-advance] VIN lookup', error.message);
      break;
    }

    for (const row of data || []) {
      const stock = String(row.inv_stock_number || '').trim();
      const vin = String(row.inv_vin || '').trim();
      if (stock && vin && !vinByStock.has(stock)) {
        vinByStock.set(stock, vin);
      }
    }
  }

  return vinByStock;
}

/** Inventory performance vehicles — get_inventory_performance_advance (+ VIN enrich). */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get('clientId')?.trim();
  const from = searchParams.get('from')?.slice(0, 10);
  const to = searchParams.get('to')?.slice(0, 10);
  const make = searchParams.get('make')?.trim() || null;
  const condition = searchParams.get('condition')?.trim() || null;
  const category = searchParams.get('category')?.trim() || null;
  const search = searchParams.get('search')?.trim() || null;

  if (!clientId || !from || !to) {
    return NextResponse.json(
      { error: 'Missing clientId, from, or to' },
      { status: 400 }
    );
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
  });

  const { data, error } = await supabase.rpc('get_inventory_performance_advance', {
    p_client_id: clientId,
    p_from: from,
    p_to: to,
    p_make: make && make !== 'all' ? make : null,
    p_condition: condition && condition !== 'all' ? condition : null,
    p_category: category && category !== 'all' ? category : null,
    p_search: search || null,
  });

  if (error) {
    console.error('[inventory-performance-advance]', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let rows = data ?? [];

  // Deployed RPC may still return inv_stock_number only — VIN is on smart_final_data.
  if (needsVinEnrichment(rows)) {
    const vinByStock = await lookupVinByStock(
      supabase,
      clientId,
      rows.map((r) => r.inv_stock_number)
    );
    rows = rows.map((r) => {
      const stock = String(r.inv_stock_number || '').trim();
      const vin =
        (r.inv_vin && String(r.inv_vin).trim()) ||
        vinByStock.get(stock) ||
        '';
      return {
        inv_vin: vin || null,
        inv_stock_number: stock || null,
        inv_make: r.inv_make,
        inv_model: r.inv_model,
        inv_year: r.inv_year,
        inv_condition: r.inv_condition,
        inv_category: r.inv_category,
        views: r.views,
        unique_views: r.unique_views,
      };
    });
  }

  return NextResponse.json({ rows });
}
