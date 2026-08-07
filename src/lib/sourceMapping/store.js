import {
  defaultChannels,
  defaultMappingEntries,
  rawPairKey,
} from '@/lib/sourceMapping/defaults';

export function normalizeChannelRow(row) {
  return {
    id: String(row.id),
    name: String(row.name || 'Channel'),
    color: String(row.color || '#94a3b8'),
    sortOrder: Number(row.sort_order ?? row.sortOrder) || 0,
    isUnmapped: Boolean(row.is_unmapped ?? row.isUnmapped),
  };
}

export function normalizeRuleRow(row) {
  return {
    rawSource: String(row.raw_source ?? row.rawSource ?? '').trim() || '(direct)',
    rawMedium: String(row.raw_medium ?? row.rawMedium ?? '').trim() || '(none)',
    channelId: String(row.channel_id ?? row.channelId ?? 'unmapped'),
  };
}

export async function loadSourceMapping(supabase) {
  const [{ data: chRows, error: chErr }, { data: ruleRows, error: ruleErr }] =
    await Promise.all([
      supabase
        .from('smart_source_mapping_channels')
        .select('id, name, color, sort_order, is_unmapped')
        .order('sort_order', { ascending: true }),
      supabase
        .from('smart_source_mapping_rules')
        .select('raw_source, raw_medium, channel_id'),
    ]);

  if (chErr || ruleErr) {
    const msg = chErr?.message || ruleErr?.message || 'Failed to load source mapping';
    const missing = /could not find the table|relation .* does not exist|schema cache/i.test(
      msg
    );
    return {
      channels: defaultChannels(),
      mapping: Object.fromEntries(
        defaultMappingEntries().map((e) => [
          rawPairKey(e.rawSource, e.rawMedium),
          e.channelId,
        ])
      ),
      rules: defaultMappingEntries(),
      fromDefaults: true,
      missingTable: missing,
      error: msg,
    };
  }

  let channels = (chRows || []).map(normalizeChannelRow);
  if (!channels.length) channels = defaultChannels();

  const rules = (ruleRows || []).map(normalizeRuleRow);
  const mapping = Object.fromEntries(
    rules.map((r) => [rawPairKey(r.rawSource, r.rawMedium), r.channelId])
  );

  return { channels, mapping, rules, fromDefaults: false, missingTable: false };
}

export async function saveSourceMapping(supabase, { channels, rules }) {
  const chList = (channels || []).map((c, i) => ({
    id: String(c.id),
    name: String(c.name || 'Channel').trim() || 'Channel',
    color: String(c.color || '#94a3b8'),
    sort_order: Number(c.sortOrder ?? (i + 1) * 10) || (i + 1) * 10,
    is_unmapped: Boolean(c.isUnmapped) || c.id === 'unmapped',
    updated_at: new Date().toISOString(),
  }));

  // Ensure Unmapped exists
  if (!chList.some((c) => c.id === 'unmapped')) {
    chList.push({
      id: 'unmapped',
      name: 'Unmapped',
      color: '#94a3b8',
      sort_order: 999,
      is_unmapped: true,
      updated_at: new Date().toISOString(),
    });
  }

  const validIds = new Set(chList.map((c) => c.id));
  const ruleList = [];
  const seen = new Set();
  for (const r of rules || []) {
    const rawSource = String(r.rawSource || '').trim() || '(direct)';
    const rawMedium = String(r.rawMedium || '').trim() || '(none)';
    const key = rawPairKey(rawSource, rawMedium);
    if (seen.has(key)) continue;
    seen.add(key);
    let channelId = String(r.channelId || 'unmapped');
    if (!validIds.has(channelId)) channelId = 'unmapped';
    ruleList.push({
      raw_source: rawSource,
      raw_medium: rawMedium,
      channel_id: channelId,
      updated_at: new Date().toISOString(),
    });
  }

  // Replace strategy: delete rules, upsert channels, delete removed channels, insert rules
  const { error: delRulesErr } = await supabase
    .from('smart_source_mapping_rules')
    .delete()
    .not('id', 'is', null);
  if (delRulesErr) throw new Error(delRulesErr.message);

  const { error: upsertChErr } = await supabase
    .from('smart_source_mapping_channels')
    .upsert(chList, { onConflict: 'id' });
  if (upsertChErr) throw new Error(upsertChErr.message);

  const keepIds = chList.map((c) => c.id);
  const { data: existing } = await supabase
    .from('smart_source_mapping_channels')
    .select('id');
  const toDelete = (existing || [])
    .map((r) => r.id)
    .filter((id) => !keepIds.includes(id));
  if (toDelete.length) {
    const { error: delChErr } = await supabase
      .from('smart_source_mapping_channels')
      .delete()
      .in('id', toDelete);
    if (delChErr) throw new Error(delChErr.message);
  }

  if (ruleList.length) {
    const { error: insErr } = await supabase
      .from('smart_source_mapping_rules')
      .insert(ruleList);
    if (insErr) throw new Error(insErr.message);
  }

  return loadSourceMapping(supabase);
}
