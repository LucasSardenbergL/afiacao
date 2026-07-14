// supabase/functions/carteira-rebuild/index.ts
// Reconstrói carteira_assignments: LISTA de membros (omie_clientes) × VENDEDOR account-correto da proof
// oben (omie_customer_account_map_fresco, P0-B-bis) × omie_vendedor_map. O vendedor NÃO vem mais do
// espelho poluído — só a lista (preserva a herança B-lite + a cobertura). Órfão → Hunter. Idempotente.
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

// MIRROR-START carteira-load — espelhado verbatim de src/lib/carteira/rebuild-helpers.ts (P0-B-bis 2/2)
function coerceCodigoVendedor(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null;
  const b = BigInt(raw);
  return b > 0n && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : null;
}
function montarClientes(espelhoIds: string[], proofOben: Map<string, number | null>): OmieClienteRow[] {
  return espelhoIds.map((customer_user_id) => ({
    customer_user_id,
    omie_codigo_vendedor: proofOben.get(customer_user_id) ?? null,
  }));
}
function avaliarGuardProof(m: { proofCrua: number; proofFresca: number; comVendedor: number }): { abortar: boolean; motivo: string | null } {
  if (m.proofFresca === 0) {
    return { abortar: true, motivo: 'proof oben fresca vazia (sync parado / TTL 7d expirado)' };
  }
  if (m.proofCrua > 0 && m.proofFresca < 0.5 * m.proofCrua) {
    return { abortar: true, motivo: `proof oben fresca (${m.proofFresca}) < 50% da crua (${m.proofCrua}) — TTL/sync degradado` };
  }
  if (m.comVendedor === 0) {
    return { abortar: true, motivo: 'proof oben sem vendedor nao-null (ponta 1 nao surtiu efeito) — preservando carteira' };
  }
  return { abortar: false, motivo: null };
}
function avaliarGuardResultado(m: { omieElegivelNovo: number; baselinePersistido: number; autorizado: boolean }): { abortar: boolean; motivo: string | null; novoBaseline: number } {
  if (m.omieElegivelNovo === 0) {
    return { abortar: true, motivo: '0 assignments omie elegiveis (carteira 100% Hunter) — abortado p/ preservar', novoBaseline: m.baselinePersistido };
  }
  if (m.autorizado) {
    return { abortar: false, motivo: null, novoBaseline: m.omieElegivelNovo };
  }
  if (m.baselinePersistido === 0) {
    return { abortar: true, motivo: 'bootstrap (baseline persistido=0) exige autorizacao explicita — cron nao faz bootstrap', novoBaseline: 0 };
  }
  if (m.omieElegivelNovo < 0.8 * m.baselinePersistido) {
    return { abortar: true, motivo: `regressao: omie elegivel novo (${m.omieElegivelNovo}) < 80% do baseline saudavel (${m.baselinePersistido})`, novoBaseline: m.baselinePersistido };
  }
  return { abortar: false, motivo: null, novoBaseline: Math.max(m.baselinePersistido, m.omieElegivelNovo) };
}
function parseBaselineSaudavel(raw: string | null | undefined): number | null {
  if (raw == null || !/^[0-9]+$/.test(raw)) return null;
  const b = BigInt(raw);
  return b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : null;
}
// MIRROR-END

const fail = (msg: string, status = 500) =>
  new Response(JSON.stringify({ ok: false, error: msg }), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // Flag de bootstrap: ?bootstrap=1 autoriza gravar quando não há baseline saudável (ou resetá-lo numa queda
  // legítima grande). Gated em service_role/cron-secret — NÃO staff comum (Codex R3 #2: employee comprometido
  // não força bootstrap destrutivo). O cron ROTINEIRO chama sem o param → nunca faz bootstrap nem destrava a catraca.
  const autorizado = new URL(req.url).searchParams.get('bootstrap') === '1'
    && (auth.via === 'service_role' || auth.via === 'cron');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // 1. Carregar mapa + hunter (tabelas pequenas). FAIL-CLOSED: erro de leitura estrutural aborta ANTES
  // de qualquer upsert — senão vendedorMap=[] mandaria a carteira inteira pro Hunter (P1.4 Codex).
  const [mapRes, hunterRes, baselineRes] = await Promise.all([
    supabase.from('omie_vendedor_map').select('omie_codigo_vendedor, user_id'),
    supabase.from('company_config').select('value').eq('key', 'carteira_hunter_user_id').maybeSingle(),
    supabase.from('company_config').select('value').eq('key', 'carteira_omie_baseline').maybeSingle(),
  ]);
  if (mapRes.error) { console.error('[carteira-rebuild] load vendedor_map error:', mapRes.error.message); return fail(`vendedor_map: ${mapRes.error.message}`); }
  if (hunterRes.error) { console.error('[carteira-rebuild] load hunter error:', hunterRes.error.message); return fail(`hunter: ${hunterRes.error.message}`); }
  if (baselineRes.error) { console.error('[carteira-rebuild] load baseline error:', baselineRes.error.message); return fail(`baseline: ${baselineRes.error.message}`); }
  // Baseline saudável persistido (omie elegível do último rebuild bom). Ausente → 0 (bootstrap). Valor CORROMPIDO
  // (não-decimal / > 2^53) → ABORTA (Codex R3 P2: não deixar "4797lixo"→4797, "1e9"→1, gigante→Infinity/congelar).
  const baselinePersistido = parseBaselineSaudavel((baselineRes.data?.value as string | null | undefined) ?? '0');
  if (baselinePersistido === null) { console.error('[carteira-rebuild] baseline corrompido:', baselineRes.data?.value); return fail(`baseline corrompido: ${baselineRes.data?.value}`); }
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

  // LISTA de membros = espelho omie_clientes (só user_id). Preserva a herança B-lite (gêmeo + clones no
  // mesmo grupo) E a cobertura (não encolhe → sem stale). O VENDEDOR não vem mais daqui (poluído/NULL).
  // Paginação robusta a max_rows (#7 Codex): avança pela quantidade REAL retornada e para na página VAZIA
  // — não presume PAGE=1000 (se o servidor capar em 500, `< PAGE` truncaria na 1ª página). Guard anti-loop.
  const PAGE = 1000;
  const MAX_ROWS = 500_000;
  const espelhoIds: string[] = [];
  for (let from = 0; ;) {
    const { data, error } = await supabase
      .from('omie_clientes')
      .select('user_id')
      .not('user_id', 'is', null)
      .order('user_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('[carteira-rebuild] load omie_clientes error:', error.message); return fail(error.message); }
    const page = (data ?? []) as Array<{ user_id: string }>;
    for (const r of page) espelhoIds.push(r.user_id);
    if (page.length === 0) break;
    from += page.length;
    if (from > MAX_ROWS) { console.error('[carteira-rebuild] omie_clientes excedeu MAX_ROWS'); return fail('paginacao omie_clientes excedeu limite'); }
  }

  // VENDEDOR account-correto = view FRESCA omie_customer_account_map_fresco (account='oben') → Map por
  // user_id. Document-first + fail-closed doc-ambíguo (account-safe, Codex); vendedor populado de
  // recomendacoes (ponta 1, #1293). coerceCodigoVendedor é bigint-safe. Mesma paginação robusta (#7).
  const proofOben = new Map<string, number | null>();
  let comVendedor = 0;
  for (let from = 0; ;) {
    const { data, error } = await supabase
      .from('omie_customer_account_map_fresco')
      .select('user_id, omie_codigo_vendedor')
      .eq('account', 'oben')
      .not('user_id', 'is', null)
      .order('user_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('[carteira-rebuild] load proof oben error:', error.message); return fail(`proof oben: ${error.message}`); }
    const page = (data ?? []) as Array<{ user_id: string; omie_codigo_vendedor: number | string | null }>;
    for (const r of page) {
      const cod = coerceCodigoVendedor(r.omie_codigo_vendedor);
      proofOben.set(r.user_id, cod);
      if (cod != null) comVendedor++;
    }
    if (page.length === 0) break;
    from += page.length;
    if (from > MAX_ROWS) { console.error('[carteira-rebuild] proof oben excedeu MAX_ROWS'); return fail('paginacao proof oben excedeu limite'); }
  }

  // Denominador do guard de frescor = proof oben CRUA (sem TTL), não o espelho misto (#4 Codex): isola a
  // degradação por TTL/sync. A carteira ATUAL NÃO entra no guard (Codex R3 #1: o comparativo é SÓ vs o baseline
  // persistido — senão baseline=0 && atual>0, após uma persistência falha, reabriria a catraca).
  const { count: proofCruaRaw, error: cruaErr } = await supabase
    .from('omie_customer_account_map').select('*', { count: 'exact', head: true }).eq('account', 'oben').not('user_id', 'is', null);
  if (cruaErr) { console.error('[carteira-rebuild] count proof crua error:', cruaErr.message); return fail(`proof crua: ${cruaErr.message}`); }
  const proofCrua = proofCruaRaw ?? 0;

  // Guard PRÉ-compute fail-closed: proof oben anômala → aborta ANTES de qualquer upsert (senão a carteira
  // zeraria p/ Hunter silenciosamente). Análogo ao guard de vendedor_map vazio (:155).
  const guardPre = avaliarGuardProof({ proofCrua, proofFresca: proofOben.size, comVendedor });
  if (guardPre.abortar) { console.error('[carteira-rebuild] guard proof oben:', guardPre.motivo); return fail(`guard proof oben: ${guardPre.motivo}`); }

  // Merge: LISTA (espelho) × VENDEDOR (proof oben). Clone ausente da proof → null → herda do gêmeo no grupo.
  const clientes = montarClientes(espelhoIds, proofOben);

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

  // 2c. Rows finais — eligible EXPLÍCITO pós-flaggeds (clone a.eligible E não-fornecedor: é o que esconde
  // os clones / reativa no rollback / retira fornecedor). Conserta o bug do upsert que omitia eligible.
  const now = new Date().toISOString();
  const rows = assignments.map((a) => ({
    customer_user_id: a.customer_user_id,
    owner_user_id: a.owner_user_id,
    source: a.source,
    omie_codigo_vendedor: a.omie_codigo_vendedor,
    eligible: a.eligible && !flaggeds.has(a.customer_user_id),
    updated_at: now,
    last_synced_at: now,
  }));

  // 2d. Guard PÓS-compute (Codex R1-R3): conta só omie ELEGÍVEL (#3); BLOQUEIA o bootstrap quando o baseline
  // PERSISTIDO é 0 sem ?bootstrap=1 — INDEPENDENTE da carteira atual (R3 #1); compara SÓ com o baseline persistido
  // (fator 0.8, monotônico → sem catraca). Nunca grava carteira integralmente órfã.
  const omieElegivelNovo = rows.filter((r) => r.source === 'omie' && r.eligible).length;
  const guardPos = avaliarGuardResultado({ omieElegivelNovo, baselinePersistido, autorizado });
  if (guardPos.abortar) { console.error('[carteira-rebuild] guard resultado:', guardPos.motivo); return fail(`guard resultado: ${guardPos.motivo}`); }

  // 3. Upsert idempotente.

  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from('carteira_assignments').upsert(chunk, { onConflict: 'customer_user_id' });
    if (error) { console.error('[carteira-rebuild] upsert error:', error.message); return fail(error.message); }
    upserted += chunk.length;
  }

  if (conflicts.length) console.warn('[carteira-rebuild] conflitos de mapeamento:', JSON.stringify(conflicts));

  // Persiste o baseline saudável (sobe com recorde; reset só via ?bootstrap=1). Protege os próximos rebuilds
  // do cron contra catraca. Falha aqui é NÃO-fatal (a carteira já foi gravada) e mantém o cron fail-closed.
  if (guardPos.novoBaseline !== baselinePersistido) {
    const { error: bErr } = await supabase.from('company_config')
      .upsert({ key: 'carteira_omie_baseline', value: String(guardPos.novoBaseline) }, { onConflict: 'key' });
    if (bErr) console.warn('[carteira-rebuild] falha ao persistir baseline (nao-fatal):', bErr.message);
  }

  return new Response(JSON.stringify({
    ok: true, upserted, orphanCount, omieElegivelNovo, comVendedor,
    proofFresca: proofOben.size, proofCrua, baselinePersistido, novoBaseline: guardPos.novoBaseline,
    autorizado, via: auth.via, conflicts, hunterUserId, aliasesAtivos: aliasMap.size,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
