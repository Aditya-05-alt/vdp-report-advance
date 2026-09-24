/**
 * Google Ads Cost (spend) for All Dealers Dealer Breakdown.
 * Uses get_all_dealers_ads_cost_advance via /api/dashboard/all-dealers-ads-cost.
 */

/**
 * @returns {Promise<Map<string, number>>} client_id / customer_id → cost
 */
export async function fetchAllDealersAdsCost({ from, to, onCancelCheck }) {
  if (typeof window === 'undefined') return new Map();
  if (!from || !to) return new Map();
  if (onCancelCheck?.()) return new Map();

  const qs = new URLSearchParams({ from, to });
  const res = await fetch(`/api/dashboard/all-dealers-ads-cost?${qs}`, {
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));

  if (onCancelCheck?.()) return new Map();
  if (!res.ok) {
    throw new Error(json.error || `Ads cost request failed (${res.status})`);
  }

  const map = new Map();
  for (const row of json.data || []) {
    const cost = Number(row.cost) || 0;
    const clientId = String(row.client_id || '').trim();
    const customerId =
      row.customer_id != null ? String(row.customer_id).trim() : '';
    if (clientId) {
      map.set(clientId, (map.get(clientId) || 0) + cost);
    }
    if (customerId && customerId !== clientId) {
      map.set(customerId, (map.get(customerId) || 0) + cost);
    }
  }
  return map;
}
