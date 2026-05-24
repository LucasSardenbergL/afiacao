import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';

type CarteiraSource = 'omie' | 'hunter_orphan';
interface OmieClienteRow { customer_user_id: string; omie_codigo_vendedor: number | null; }
interface VendedorMapRow { omie_codigo_vendedor: number; user_id: string; }
interface ComputedAssignment {
  customer_user_id: string; owner_user_id: string; source: CarteiraSource; omie_codigo_vendedor: number | null;
}
interface MappingConflict { customer_user_id: string; omie_codigo_vendedor: number; candidate_user_ids: string[]; }

function computeCarteira(
  clientes: OmieClienteRow[], vendedorMap: VendedorMapRow[], hunterUserId: string | null,
): { assignments: ComputedAssignment[]; conflicts: MappingConflict[]; orphanCount: number } {
  const codeToUsers = new Map<number, Set<string>>();
  for (const m of vendedorMap) {
    if (!codeToUsers.has(m.omie_codigo_vendedor)) codeToUsers.set(m.omie_codigo_vendedor, new Set());
    codeToUsers.get(m.omie_codigo_vendedor)!.add(m.user_id);
  }
  const assignments: ComputedAssignment[] = [];
  const conflicts: MappingConflict[] = [];
  let orphanCount = 0;
  for (const c of clientes) {
    const code = c.omie_codigo_vendedor;
    const users = code != null ? codeToUsers.get(code) : undefined;
    if (code != null && users) {
      if (users.size === 1) {
        assignments.push({ customer_user_id: c.customer_user_id, owner_user_id: [...users][0], source: 'omie', omie_codigo_vendedor: code });
        continue;
      }
      conflicts.push({ customer_user_id: c.customer_user_id, omie_codigo_vendedor: code, candidate_user_ids: [...users].sort() });
      continue;
    }
    orphanCount++;
    if (hunterUserId) {
      assignments.push({ customer_user_id: c.customer_user_id, owner_user_id: hunterUserId, source: 'hunter_orphan', omie_codigo_vendedor: code ?? null });
    }
  }
  return { assignments, conflicts, orphanCount };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const [mapRes, hunterRes] = await Promise.all([
    supabase.from('omie_vendedor_map').select('omie_codigo_vendedor, user_id'),
    supabase.from('company_config').select('value').eq('key', 'carteira_hunter_user_id').maybeSingle(),
  ]);
  const vendedorMap = (mapRes.data ?? []) as VendedorMapRow[];
  const rawHunter = (hunterRes.data?.value as string | null | undefined) ?? null;
  const hunterUserId = rawHunter ? (rawHunter.replace(/^"|"$/g, '').trim() || null) : null;

  const clientes: OmieClienteRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('omie_clientes')
      .select('user_id, omie_codigo_vendedor')
      .not('user_id', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('[carteira-rebuild] load omie_clientes error:', error.message);
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const page = (data ?? []) as Array<{ user_id: string; omie_codigo_vendedor: number | null }>;
    for (const r of page) clientes.push({ customer_user_id: r.user_id, omie_codigo_vendedor: r.omie_codigo_vendedor });
    if (page.length < PAGE) break;
  }

  const { assignments, conflicts, orphanCount } = computeCarteira(clientes, vendedorMap, hunterUserId);

  const now = new Date().toISOString();
  const rows = assignments.map((a) => ({
    customer_user_id: a.customer_user_id,
    owner_user_id: a.owner_user_id,
    source: a.source,
    omie_codigo_vendedor: a.omie_codigo_vendedor,
    updated_at: now,
    last_synced_at: now,
  }));

  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from('carteira_assignments')
      .upsert(chunk, { onConflict: 'customer_user_id' });
    if (error) {
      console.error('[carteira-rebuild] upsert error:', error.message);
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    upserted += chunk.length;
  }

  if (conflicts.length) console.warn('[carteira-rebuild] conflitos de mapeamento:', JSON.stringify(conflicts));

  return new Response(JSON.stringify({ ok: true, upserted, orphanCount, conflicts, hunterUserId }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
