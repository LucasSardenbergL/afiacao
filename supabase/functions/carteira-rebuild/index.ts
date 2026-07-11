// supabase/functions/carteira-rebuild/index.ts
// Reconstrói carteira_assignments. UNIVERSO = user_ids de omie_clientes; VENDEDOR = proof account-correta
// omie_customer_account_map_fresco (account=oben) — NÃO o espelho poluído (era 100% NULL → carteira 100%
// Hunter, incidente P0-B-bis ponta 2/2). Órfão (sem vendedor oben) → Hunter. Idempotente (upsert/customer).
//
// Consolidação B-lite (spec 2026-06-13): consulta customer_canonical_alias (clones ATIVOS) e canonicaliza
// clone→gêmeo — o gêmeo (cadastro Oben) herda o vendedor do grupo e fica eligible=true; o clone (cadastro
// Colacor SC) fica eligible=false (escondido, preservado). Como o vendedor agora vem SÓ da proof OBEN, o
// clone colacor_sc resolve AUSENTE (não tem linha oben) → herança cross-account ELIMINADA por construção
// (Codex R2 P1: filtro oben quebraria o B-lite — resolvido lendo o vendedor por-user, não trocando o
// universo). aliasMap vazio = comportamento legado + eligible explícito.
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

// Resolve o vendedor OBEN por user a partir da proof account-correta (ponta 2/2 do incidente carteira-Hunter).
// Espelhado de src/lib/carteira/vendedor-oben.ts — paridade textual no CI (edge-money-path-invariants).
interface OmieVendedorObenRow { user_id: string; omie_codigo_vendedor: number | null; }
interface VendedorObenResolvido { vendedorPorUser: Map<string, number>; ambiguos: string[]; }
// MIRROR-START carteira-vendedor-oben — espelhado verbatim de src/lib/carteira/vendedor-oben.ts
function resolverVendedorObenPorUser(rows: OmieVendedorObenRow[]): VendedorObenResolvido {
  const codigoValido = (v: number | null): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  const porUser = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!r.user_id) continue;
    let s = porUser.get(r.user_id);
    if (!s) { s = new Set<number>(); porUser.set(r.user_id, s); }
    if (codigoValido(r.omie_codigo_vendedor)) s.add(r.omie_codigo_vendedor);
  }
  const vendedorPorUser = new Map<string, number>();
  const ambiguos: string[] = [];
  for (const [user, vends] of porUser) {
    if (vends.size === 1) vendedorPorUser.set(user, [...vends][0]);
    else if (vends.size > 1) ambiguos.push(user); // size 0 → órfão (fora do mapa, sem vendedor)
  }
  return { vendedorPorUser, ambiguos };
}
// MIRROR-END

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
  // ACCOUNT-SAFE (Codex ponta-2 P2): omie_vendedor_map É por-conta (coluna omie_account; o MESMO vendedor
  // tem código diferente em oben/colacor/colacor_sc). Como o código do cliente vem da proof OBEN, o mapa
  // código→owner também tem de ser filtrado por oben — senão um código que colidisse entre contas mapearia
  // um owner de outra conta. Fecha o contrato "owner é oben" que o código-account-safe sozinho não prova.
  const [mapRes, hunterRes] = await Promise.all([
    supabase.from('omie_vendedor_map').select('omie_codigo_vendedor, user_id').eq('omie_account', 'oben'),
    supabase.from('company_config').select('value').eq('key', 'carteira_hunter_user_id').maybeSingle(),
  ]);
  if (mapRes.error) { console.error('[carteira-rebuild] load vendedor_map error:', mapRes.error.message); return fail(`vendedor_map: ${mapRes.error.message}`); }
  if (hunterRes.error) { console.error('[carteira-rebuild] load hunter error:', hunterRes.error.message); return fail(`hunter: ${hunterRes.error.message}`); }
  const vendedorMap = (mapRes.data ?? []) as VendedorMapRow[];
  // vendedor_map oben vazio é anômalo (sempre há vendedores oben) e mandaria todos pro Hunter → aborta.
  if (vendedorMap.length === 0) { console.error('[carteira-rebuild] vendedor_map oben vazio — abortando'); return fail('vendedor_map oben vazio (anômalo)'); }
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

  // UNIVERSO da carteira = user_ids de omie_clientes UNIÃO os users da proof oben. O user_id NÃO é o dado
  // poluído (só empresa_omie/omie_codigo_vendedor eram); o VENDEDOR não vem mais daqui (era 100% NULL →
  // incidente carteira-Hunter) e sim da proof abaixo. A UNIÃO garante que um cliente presente na proof oben
  // mas AUSENTE do espelho (cliente novo / atraso do espelho) não suma da carteira (Codex ponta-2 P2).
  // Trocar o universo SÓ p/ a proof (redução 6909→5238 + reconciliação do upsert-only) é a Fatia 4 / DROP.
  // Paginação KEYSET (.gt + .order + .limit), NÃO offset .range: a proof fresca muda entre páginas (TTL 7d
  // expira no limite, sync concorrente insere) e offset deslocaria/pularia linhas (Codex ponta-2 P1).
  const PAGE = 1000;
  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
  const universoSet = new Set<string>();
  {
    let last = ZERO_UUID;
    for (;;) {
      const { data, error } = await supabase
        .from('omie_clientes')
        .select('user_id')
        .not('user_id', 'is', null)
        .gt('user_id', last)
        .order('user_id', { ascending: true })
        .limit(PAGE);
      if (error) { console.error('[carteira-rebuild] load universo (omie_clientes) error:', error.message); return fail(error.message); }
      const page = (data ?? []) as Array<{ user_id: string }>;
      for (const r of page) if (r.user_id) universoSet.add(r.user_id);
      if (page.length < PAGE) break;
      last = page[page.length - 1].user_id;
    }
  }

  // VENDEDOR account-correto: proof FRESCA omie_customer_account_map_fresco, account=oben (a carteira é do
  // cadastro Oben canônico — design §4 #6). NUNCA o espelho poluído; NUNCA a base (a view filtra
  // updated_at >= now()-7d — a base reabriria stale infinito). Keyset por user_id (único por conta na proof).
  const proofObenRows: OmieVendedorObenRow[] = [];
  {
    let last = ZERO_UUID;
    for (;;) {
      const { data, error } = await supabase
        .from('omie_customer_account_map_fresco')
        .select('user_id, omie_codigo_vendedor')
        .eq('account', 'oben')
        .not('user_id', 'is', null)
        .gt('user_id', last)
        .order('user_id', { ascending: true })
        .limit(PAGE);
      if (error) { console.error('[carteira-rebuild] load proof oben error:', error.message); return fail(`proof oben: ${error.message}`); }
      const page = (data ?? []) as OmieVendedorObenRow[];
      for (const r of page) proofObenRows.push(r);
      if (page.length < PAGE) break;
      last = page[page.length - 1].user_id;
    }
  }
  // Guard A (fail-closed anti-zeramento): proof oben SEM NENHUMA linha fresca é anômalo (sync da proof
  // parou >7d, ou a view sumiu) → ABORTA antes de escrever, senão zerar-em-silêncio mandaria tudo pro Hunter.
  if (proofObenRows.length === 0) {
    console.error('[carteira-rebuild] proof oben (omie_customer_account_map_fresco) VAZIA — abortando (anômalo)');
    return fail('proof oben vazia (omie_customer_account_map_fresco) — sync da proof parado?');
  }
  // União: adiciona os users da proof oben ao universo (cliente oben sem linha no espelho não some).
  for (const r of proofObenRows) if (r.user_id) universoSet.add(r.user_id);

  const { vendedorPorUser, ambiguos } = resolverVendedorObenPorUser(proofObenRows);
  if (ambiguos.length) {
    console.warn(`[carteira-rebuild] ${ambiguos.length} users com vendedor oben AMBÍGUO (fail-closed, não atribuídos):`, JSON.stringify(ambiguos.slice(0, 50)));
  }
  // Guard A2 (fail-closed anti-bootstrap-fail-open — Codex ponta-2 P1): proof COM linhas mas ZERO vendedor
  // resolvido é o estado EXATO do incidente (writer #1293 não deployado/não rodou → vendedor 100% NULL na
  // proof). O Guard B (relativo à saída) fica desativado no bootstrap (base=0), então SEM isto o rebuild
  // retornaria ok e manteria tudo Hunter EM SILÊNCIO. O modo de falha é binário (o writer popula ~todos os
  // clientes-com-vendedor ou nenhum) → size===0 é o sinal certo e força a ordem de deploy (ponta 1 antes).
  if (vendedorPorUser.size === 0) {
    console.error('[carteira-rebuild] proof oben SEM nenhum vendedor resolvido — writer omie-analytics-sync (#1293) deployado/rodou?');
    return fail('proof oben sem vendedor resolvido — o writer omie-analytics-sync (#1293) foi deployado e rodou?');
  }

  // clientes[] = universo × vendedor-da-proof-oben. Ausência na proof → vendedor null → órfão/Hunter
  // (degradação honesta). Clone colacor_sc (sem linha oben) resolve null → NÃO injeta seu vendedor no
  // gêmeo oben na consolidação B-lite: a herança cross-account fica ELIMINADA por construção (invariante 2).
  const clientes: OmieClienteRow[] = [...universoSet].map((user_id) => ({
    customer_user_id: user_id,
    omie_codigo_vendedor: vendedorPorUser.get(user_id) ?? null,
  }));

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

  // Guard B (fail-closed anti-encolhimento — Codex R2 P1: fail-open se a view fresca encolher): se a proof
  // oben ENCOLHER (staleness parcial da view 7d), o nº de assignments com vendedor real (source=omie
  // visível) despencaria e a carteira degradaria em silêncio. Compara o novo total com o ATUAL na tabela;
  // queda >30% ABORTA sem escrever. Bootstrap-safe: hoje a carteira é 100% Hunter (base=0) → o 1º run
  // pós-#1293 só CRESCE (não dispara). Ausência total (proof vazia) já foi barrada no Guard A.
  const novoOmieVisivel = rows.filter((r) => r.source === 'omie' && r.eligible).length;
  {
    const { count: atual, error: cntErr } = await supabase
      .from('carteira_assignments')
      .select('*', { count: 'exact', head: true })
      .eq('source', 'omie')
      .eq('eligible', true);
    if (cntErr) { console.error('[carteira-rebuild] count atual source=omie error:', cntErr.message); return fail(`count atual source=omie: ${cntErr.message}`); }
    const base = atual ?? 0;
    if (base > 0 && novoOmieVisivel < base * 0.7) {
      console.error(`[carteira-rebuild] encolhimento suspeito de vendedores atribuídos: atual=${base} novo=${novoOmieVisivel} (<70%) — abortando sem escrever`);
      return fail(`encolhimento suspeito da proof oben (vendedores visíveis ${base}→${novoOmieVisivel}) — não vou zerar a carteira`);
    }
  }

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
    // observabilidade da fonte account-safe: quantos users tinham vendedor oben resolvido, quantos ambíguos
    // (fail-closed), e o tamanho da proof lida — para provar que a carteira saiu do 100%-Hunter pós-#1293.
    proofObenLinhas: proofObenRows.length, vendedoresObenResolvidos: vendedorPorUser.size, ambiguosCount: ambiguos.length,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
