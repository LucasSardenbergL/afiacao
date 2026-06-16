// supabase/functions/carteira-rebuild/index.ts
// Reconstrói carteira_assignments a partir de omie_clientes × omie_vendedor_map.
// Órfão (sem vendedor mapeado) → Hunter. Idempotente (upsert por customer_user_id).
//
// Consolidação B-lite (spec 2026-06-13): consulta customer_canonical_alias (clones ATIVOS) e
// canonicaliza clone→gêmeo — o gêmeo (cadastro Oben, com nome) herda o vendedor do clone e fica
// eligible=true; o clone (cadastro Colacor SC, sem nome) fica eligible=false (escondido da tela,
// preservado no banco). aliasMap vazio = comportamento legado + eligible explícito.
//
// Setup pg_cron (manual pós-merge), roda após o sync do Omie:
//   SELECT cron.schedule('carteira-rebuild-nightly', '30 7 * * *',
//     $$ SELECT net.http_post(
//       url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/carteira-rebuild',
//       headers := jsonb_build_object('x-cron-secret',
//         (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1))
//     ); $$);

import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';

type CarteiraSource = 'omie' | 'hunter_orphan';
interface OmieClienteRow { customer_user_id: string; omie_codigo_vendedor: number | null; }
interface VendedorMapRow { omie_codigo_vendedor: number; user_id: string; }
interface ComputedAssignment {
  customer_user_id: string; owner_user_id: string; source: CarteiraSource; omie_codigo_vendedor: number | null; eligible: boolean;
}
interface MappingConflict { customer_user_id: string; omie_codigo_vendedor: number; candidate_user_ids: string[]; }
interface RebuildResult { assignments: ComputedAssignment[]; conflicts: MappingConflict[]; orphanCount: number; chainViolations: string[]; }

type Resolved =
  | { kind: 'omie'; user: string; code: number }
  | { kind: 'conflict'; code: number; users: string[] }
  | { kind: 'orphan'; code: number | null };

// ESPELHO de src/lib/carteira/rebuild-helpers.ts (manter idêntico)
function computeCarteira(
  clientes: OmieClienteRow[], vendedorMap: VendedorMapRow[], hunterUserId: string | null,
  aliasMap: Map<string, string> = new Map(),
): RebuildResult {
  const codeToUsers = new Map<number, Set<string>>();
  for (const m of vendedorMap) {
    if (!codeToUsers.has(m.omie_codigo_vendedor)) codeToUsers.set(m.omie_codigo_vendedor, new Set());
    codeToUsers.get(m.omie_codigo_vendedor)!.add(m.user_id);
  }
  const cloneIds = new Set(aliasMap.keys());

  const chainViolations: string[] = [];
  for (const [alias, canonical] of aliasMap) {
    if (cloneIds.has(canonical)) chainViolations.push(alias);
  }

  const resolveVendedor = (c: OmieClienteRow): Resolved => {
    const code = c.omie_codigo_vendedor;
    if (code == null) return { kind: 'orphan', code: null };
    const users = codeToUsers.get(code);
    if (!users) return { kind: 'orphan', code };
    if (users.size === 1) return { kind: 'omie', user: [...users][0], code };
    return { kind: 'conflict', code, users: [...users] };
  };

  const ordenados = [...clientes].sort((a, b) =>
    a.customer_user_id < b.customer_user_id ? -1 : a.customer_user_id > b.customer_user_id ? 1 : 0);

  const grupos = new Map<string, OmieClienteRow[]>();
  const canonicalIds: string[] = [];
  const seen = new Set<string>();
  for (const c of ordenados) {
    const canonicalId = aliasMap.get(c.customer_user_id) ?? c.customer_user_id;
    let membros = grupos.get(canonicalId);
    if (!membros) { membros = []; grupos.set(canonicalId, membros); }
    membros.push(c);
    if (!cloneIds.has(canonicalId) && !seen.has(canonicalId)) { seen.add(canonicalId); canonicalIds.push(canonicalId); }
  }

  const assignments: ComputedAssignment[] = [];
  const conflicts: MappingConflict[] = [];
  let orphanCount = 0;

  const emitLegado = (c: OmieClienteRow, eligible: boolean) => {
    const v = resolveVendedor(c);
    if (v.kind === 'omie') {
      assignments.push({ customer_user_id: c.customer_user_id, owner_user_id: v.user, source: 'omie', omie_codigo_vendedor: v.code, eligible });
    } else if (v.kind === 'orphan') {
      if (eligible) orphanCount++;
      if (hunterUserId) assignments.push({ customer_user_id: c.customer_user_id, owner_user_id: hunterUserId, source: 'hunter_orphan', omie_codigo_vendedor: c.omie_codigo_vendedor ?? null, eligible });
    }
  };

  for (const canonicalId of canonicalIds) {
    const membros = grupos.get(canonicalId)!;
    const vendedoresOmie: Array<{ user: string; code: number }> = [];
    let conflitoMapeamento = false;
    let codeConflito: number | null = null;
    const candidatos = new Set<string>();
    for (const m of membros) {
      const v = resolveVendedor(m);
      if (v.kind === 'omie') vendedoresOmie.push({ user: v.user, code: v.code });
      else if (v.kind === 'conflict') { conflitoMapeamento = true; codeConflito = v.code; for (const u of v.users) candidatos.add(u); }
    }
    const usersDistintos = [...new Set(vendedoresOmie.map((x) => x.user))].sort();

    if (conflitoMapeamento || usersDistintos.length > 1) {
      conflicts.push({
        customer_user_id: canonicalId,
        omie_codigo_vendedor: codeConflito ?? (vendedoresOmie.length ? vendedoresOmie[0].code : 0),
        candidate_user_ids: [...new Set([...usersDistintos, ...candidatos])].sort(),
      });
      for (const m of membros) emitLegado(m, true);
      continue;
    }

    if (usersDistintos.length === 1) {
      const user = usersDistintos[0];
      const code = Math.min(...vendedoresOmie.filter((x) => x.user === user).map((x) => x.code));
      assignments.push({ customer_user_id: canonicalId, owner_user_id: user, source: 'omie', omie_codigo_vendedor: code, eligible: true });
    } else {
      orphanCount++;
      if (hunterUserId) {
        const canonRow = membros.find((m) => m.customer_user_id === canonicalId);
        assignments.push({ customer_user_id: canonicalId, owner_user_id: hunterUserId, source: 'hunter_orphan', omie_codigo_vendedor: canonRow?.omie_codigo_vendedor ?? null, eligible: true });
      }
    }
    for (const m of membros) {
      if (m.customer_user_id === canonicalId) continue;
      emitLegado(m, false);
    }
  }

  return { assignments, conflicts, orphanCount, chainViolations };
}

const fail = (msg: string, status = 500) =>
  new Response(JSON.stringify({ ok: false, error: msg }), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // 1. Carregar mapa + hunter (tabelas pequenas). FAIL-CLOSED: erro de leitura estrutural aborta ANTES
  // de qualquer upsert — senão vendedorMap=[] mandaria a carteira inteira pro Hunter (P1.4 Codex).
  const [mapRes, hunterRes] = await Promise.all([
    supabase.from('omie_vendedor_map').select('omie_codigo_vendedor, user_id'),
    supabase.from('company_config').select('value').eq('key', 'carteira_hunter_user_id').maybeSingle(),
  ]);
  if (mapRes.error) { console.error('[carteira-rebuild] load vendedor_map error:', mapRes.error.message); return fail(`vendedor_map: ${mapRes.error.message}`); }
  if (hunterRes.error) { console.error('[carteira-rebuild] load hunter error:', hunterRes.error.message); return fail(`hunter: ${hunterRes.error.message}`); }
  const vendedorMap = (mapRes.data ?? []) as VendedorMapRow[];
  // vendedor_map vazio é anômalo (sempre há vendedores) e mandaria todos pro Hunter → aborta.
  if (vendedorMap.length === 0) { console.error('[carteira-rebuild] vendedor_map vazio — abortando'); return fail('vendedor_map vazio (anômalo)'); }
  // value pode vir como uuid puro ou JSON-quoted ("uuid") — normaliza removendo aspas.
  const rawHunter = (hunterRes.data?.value as string | null | undefined) ?? null;
  const hunterUserId = rawHunter ? (rawHunter.replace(/^"|"$/g, '').trim() || null) : null;

  // 1b. Aliases de consolidação ATIVOS (clone→canônico). FAIL-CLOSED em erro (não re-expor clones
  // escondidos). Map vazio se a Fase 2 não foi ativada → rebuild legado + eligible explícito.
  // .order p/ paginação estável (P1.5 Codex).
  const aliasMap = new Map<string, string>();
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('customer_canonical_alias')
        .select('alias_user_id, canonical_user_id')
        .eq('status', 'active')
        .order('alias_user_id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) { console.error('[carteira-rebuild] load aliases error:', error.message); return fail(`aliases: ${error.message}`); }
      const page = (data ?? []) as Array<{ alias_user_id: string; canonical_user_id: string }>;
      for (const r of page) if (r.alias_user_id && r.canonical_user_id) aliasMap.set(r.alias_user_id, r.canonical_user_id);
      if (page.length < PAGE) break;
    }
  }

  // omie_clientes pode ter milhares de linhas e o PostgREST limita o SELECT a ~1000 por página →
  // paginar com range() até esgotar. .order p/ estabilidade (P1.5 Codex).
  const clientes: OmieClienteRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('omie_clientes')
      .select('user_id, omie_codigo_vendedor')
      .not('user_id', 'is', null)
      .order('user_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('[carteira-rebuild] load omie_clientes error:', error.message); return fail(error.message); }
    const page = (data ?? []) as Array<{ user_id: string; omie_codigo_vendedor: number | null }>;
    for (const r of page) clientes.push({ customer_user_id: r.user_id, omie_codigo_vendedor: r.omie_codigo_vendedor });
    if (page.length < PAGE) break;
  }

  // Fornecedores fora da carteira (cliente_classificacao.excluir_da_carteira): entram com
  // eligible=false (combinado com o eligible-de-clone abaixo). FAIL-CLOSED: erro de leitura aborta
  // ANTES de escrever — senão um run sem o filtro reverteria o cleanup (fornecedor voltaria à carteira).
  const flaggeds = new Set<string>();
  {
    const FPAGE = 1000;
    for (let from = 0; ; from += FPAGE) {
      const { data, error } = await supabase
        .from('cliente_classificacao')
        .select('user_id')
        .eq('excluir_da_carteira', true)
        .order('user_id', { ascending: true })
        .range(from, from + FPAGE - 1);
      if (error) { console.error('[carteira-rebuild] load flaggeds error:', error.message); return fail(`flaggeds: ${error.message}`); }
      const page = (data ?? []) as Array<{ user_id: string }>;
      for (const r of page) flaggeds.add(r.user_id);
      if (page.length < FPAGE) break;
    }
  }

  // 2. Computar (espelho), canonical-aware
  const { assignments, conflicts, orphanCount, chainViolations } = computeCarteira(clientes, vendedorMap, hunterUserId, aliasMap);

  // 2b. Cadeia de alias (A→B→C) detectada → ABORTA sem escrever (P2.7 Codex). Aliases devem ser 1 nível.
  if (chainViolations.length) {
    console.error('[carteira-rebuild] cadeia de alias detectada — abortando:', JSON.stringify(chainViolations.slice(0, 20)));
    return fail(`cadeia de alias (${chainViolations.length}) — corrija customer_canonical_alias`);
  }

  // 3. Upsert idempotente — eligible EXPLÍCITO (conserta o bug do upsert que o omitia; é o que esconde
  // os clones / reativa no rollback).
  const now = new Date().toISOString();
  const rows = assignments.map((a) => ({
    customer_user_id: a.customer_user_id,
    owner_user_id: a.owner_user_id,
    source: a.source,
    omie_codigo_vendedor: a.omie_codigo_vendedor,
    // eligible = clone (a.eligible) E não-fornecedor. Fornecedor flaggeado → false (espelho reversível).
    eligible: a.eligible && !flaggeds.has(a.customer_user_id),
    updated_at: now,
    last_synced_at: now,
  }));

  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from('carteira_assignments').upsert(chunk, { onConflict: 'customer_user_id' });
    if (error) { console.error('[carteira-rebuild] upsert error:', error.message); return fail(error.message); }
    upserted += chunk.length;
  }

  if (conflicts.length) console.warn('[carteira-rebuild] conflitos de mapeamento:', JSON.stringify(conflicts));

  return new Response(JSON.stringify({
    ok: true, upserted, orphanCount, conflicts, hunterUserId, aliasesAtivos: aliasMap.size,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
