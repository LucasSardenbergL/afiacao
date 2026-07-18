// supabase/functions/carteira-rebuild/index.ts
// Reconstrói carteira_assignments: LISTA de membros (carteira_membership_ledger) × VENDEDOR account-correto
// da proof oben (omie_customer_account_map_fresco, P0-B-bis) × omie_vendedor_map. Nem a lista nem o vendedor
// vêm mais do espelho poluído omie_clientes (Fatia 1). A lista (acumulador) preserva a herança B-lite + a
// cobertura. Órfão → Hunter. Idempotente.
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

// MIRROR-START carteira-compute — computeCarteira espelhado verbatim de src/lib/carteira/rebuild-helpers.ts (P0-B-bis)
function computeCarteira(
  clientes: OmieClienteRow[],
  vendedorMap: VendedorMapRow[],
  hunterUserId: string | null,
  aliasMap: Map<string, string> = new Map(),
): RebuildResult {
  const codeToUsers = new Map<number, Set<string>>();
  for (const m of vendedorMap) {
    if (!codeToUsers.has(m.omie_codigo_vendedor)) codeToUsers.set(m.omie_codigo_vendedor, new Set());
    codeToUsers.get(m.omie_codigo_vendedor)!.add(m.user_id);
  }
  const cloneIds = new Set(aliasMap.keys());

  // Detecta cadeia/ciclo: um canônico que é, ele mesmo, um clone. NÃO degrada — sinaliza p/ abortar.
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

  // Ordena por id (determinismo de paginação e de escolha de código).
  const ordenados = [...clientes].sort((a, b) =>
    a.customer_user_id < b.customer_user_id ? -1 : a.customer_user_id > b.customer_user_id ? 1 : 0);

  // Agrupa MEMBROS por canonicalId (o gêmeo + os clones que apontam pra ele).
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
      // conta só órfão VISÍVEL (clone escondido não infla a métrica)
      if (eligible) orphanCount++;
      if (hunterUserId) assignments.push({ customer_user_id: c.customer_user_id, owner_user_id: hunterUserId, source: 'hunter_orphan', omie_codigo_vendedor: c.omie_codigo_vendedor ?? null, eligible });
    } else if (hunterUserId) {
      // CONFLITO de mapeamento (código → 2+ vendedores): QUARANTINA em vez de omitir. Omitir + upsert-only
      // (onConflict customer_user_id, sem DELETE) preservaria o assignment ANTIGO — vendedor errado, válido,
      // cobrando comissão: o furo que refutou o A′. Mesmo padrão da Fatia 2 (membro preservado, eligible=false,
      // zero comissão, reversível). Hunter é PLACEHOLDER inerte (owner_user_id é NOT NULL e o CHECK de source
      // só aceita omie|hunter_orphan → zero DDL), NÃO um palpite de dono: eligible=false já nega o efeito.
      // Preserva o código ambíguo p/ observabilidade (qual code causou). `eligible` do caller é ignorado de
      // propósito — conflito nunca é elegível, nem no ramo do clone.
      assignments.push({ customer_user_id: c.customer_user_id, owner_user_id: hunterUserId, source: 'hunter_orphan', omie_codigo_vendedor: v.code, eligible: false });
    }
  };

  for (const canonicalId of canonicalIds) {
    const membros = grupos.get(canonicalId)!;

    // Vendedores do grupo + flags de conflito.
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
      // CONFLITO → fail-closed seguro: não canonicaliza, cada membro vira legado VISÍVEL (eligible=true).
      conflicts.push({
        customer_user_id: canonicalId,
        omie_codigo_vendedor: codeConflito ?? (vendedoresOmie.length ? vendedoresOmie[0].code : 0),
        candidate_user_ids: [...new Set([...usersDistintos, ...candidatos])].sort(),
      });
      for (const m of membros) emitLegado(m, true);
      continue;
    }

    // GRUPO LIMPO → canonicaliza.
    if (usersDistintos.length === 1) {
      const user = usersDistintos[0];
      // código determinístico: menor code do vendedor herdado.
      const code = Math.min(...vendedoresOmie.filter((x) => x.user === user).map((x) => x.code));
      assignments.push({ customer_user_id: canonicalId, owner_user_id: user, source: 'omie', omie_codigo_vendedor: code, eligible: true });
    } else {
      orphanCount++;
      if (hunterUserId) {
        const canonRow = membros.find((m) => m.customer_user_id === canonicalId);
        assignments.push({ customer_user_id: canonicalId, owner_user_id: hunterUserId, source: 'hunter_orphan', omie_codigo_vendedor: canonRow?.omie_codigo_vendedor ?? null, eligible: true });
      }
    }
    // clones do grupo (membros ≠ canônico) → eligible=false (escondidos, preservados).
    for (const m of membros) {
      if (m.customer_user_id === canonicalId) continue;
      emitLegado(m, false);
    }
  }

  return { assignments, conflicts, orphanCount, chainViolations };
}
// MIRROR-END

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
function extrairQuarantinados(rows: Array<{ user_id: string; identity_state: string | null }>): Set<string> {
  // FAIL-CLOSED (Fatia 2 D2): quarantina tudo que não for EXATAMENTE 'verified' — inclui null, estado
  // futuro e qualquer valor que o CHECK venha a aceitar. A Fatia 2 só POPULA 'ambiguous', mas testar
  // `=== 'ambiguous'` falharia ABERTO (cliente de identidade dúbia pagando comissão) no dia em que outro
  // estado ganhasse gatilho. Ledger vazio → set vazio → rebuild degrada p/ o comportamento de hoje.
  const quarantinados = new Set<string>();
  for (const r of rows) if (r.identity_state !== 'verified') quarantinados.add(r.user_id);
  return quarantinados;
}
function aplicarMascaras(
  assignments: ComputedAssignment[],
  flaggeds: Set<string>,
  quarantinados: Set<string>,
): ComputedAssignment[] {
  // As 2 máscaras derrubam ELEGIBILIDADE, nunca PRESENÇA. Tirar o membro da saída faria o upsert-only
  // (onConflict customer_user_id, sem DELETE) preservar o assignment ANTIGO — vendedor errado, válido,
  // cobrando comissão (o furo que refutou o A′). eligible=false já entrega zero comissão + invisível
  // (todo leitor filtra `WHERE eligible`), e é REVERSÍVEL: volta a 'verified' → volta a valer.
  return assignments.map((a) => ({
    ...a,
    eligible: a.eligible && !flaggeds.has(a.customer_user_id) && !quarantinados.has(a.customer_user_id),
  }));
}
function verificarCobertura(
  membroIds: string[],
  rows: Array<{ customer_user_id: string }>,
): { ok: boolean; motivo: string | null } {
  // PÓS-CONDIÇÃO ESTRUTURAL (tripwire): a saída cobre EXATAMENTE o conjunto de membros do ledger.
  // Por que existe: "membro não chegou na saída" é UMA classe de bug — o conflito de mapeamento, o Hunter
  // ausente e qualquer omissão futura são instâncias dela — e o upsert-only (onConflict customer_user_id,
  // sem DELETE) transforma toda omissão em assignment ANTIGO vivo (vendedor errado, elegível, cobrando
  // comissão: o furo que refutou o A′). Os guards de cardinalidade NÃO pegam isto: contam linhas, e o
  // membro omitido some silenciosamente sem mudar contagem nenhuma. Aqui provamos o CONJUNTO.
  // Fail-closed: em anomalia o caller ABORTA sem escrever — nada novo entra, o run fica ruidoso, e o
  // estado velho é preservado por decisão explícita em vez de por omissão silenciosa.
  const esperados = new Set(membroIds);
  const vistos = new Set<string>();
  const duplicados = new Set<string>();
  const extras = new Set<string>();
  for (const r of rows) {
    if (vistos.has(r.customer_user_id)) duplicados.add(r.customer_user_id);
    vistos.add(r.customer_user_id);
    if (!esperados.has(r.customer_user_id)) extras.add(r.customer_user_id);
  }
  const faltantes: string[] = [];
  for (const id of esperados) if (!vistos.has(id)) faltantes.push(id);
  if (faltantes.length > 0) {
    return { ok: false, motivo: `cobertura: ${faltantes.length} membro(s) do ledger sem row (ex.: ${faltantes.slice(0, 3).join(', ')}) — upsert-only deixaria o assignment ANTIGO vivo (stale)` };
  }
  if (extras.size > 0) {
    return { ok: false, motivo: `cobertura: ${extras.size} row(s) p/ nao-membro do ledger (ex.: ${[...extras].slice(0, 3).join(', ')})` };
  }
  if (duplicados.size > 0) {
    return { ok: false, motivo: `cobertura: ${duplicados.size} customer_user_id duplicado(s) na saida (ex.: ${[...duplicados].slice(0, 3).join(', ')})` };
  }
  return { ok: true, motivo: null };
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

  // ── CANÁRIA DE DEPLOY (?canary=1) — a ÚNICA prova do que está SERVIDO em produção ──────────────
  // Por que existe (lacuna exposta no deploy do #1397): a paridade textual do CI cobre a FONTE (o repo),
  // não o DEPLOY — o bot do Lovable pode servir a cópia interna VELHA sem refletir na `main`. E o #1397 é
  // um no-op nos dados de hoje (0 conflitos de mapeamento), então a resposta do run REAL é byte-idêntica
  // com o código velho ou o novo: não discrimina. Esta canária discrimina em 1 request, sem escrever nada.
  //
  // A fixture é o comportamento que o #1397 mudou: código Omie → 2 vendedores (conflito de mapeamento).
  //   • código VELHO  → emitLegado NÃO emite → assignments VAZIO (o membro some → upsert-only deixaria
  //                     o assignment antigo STALE: vendedor errado, elegível, cobrando comissão);
  //   • código NOVO   → 1 row hunter_orphan + eligible=false, código preservado (quarentena: membro
  //                     preservado, zero comissão, nada stale) E verificarCobertura devolve ok=true.
  // Roda o helper REAL deployado (não uma reimplementação) — é isso que a torna prova de DEPLOY.
  // ANTES do lease e de qualquer I/O: pura, não toma o lease (senão uma canária bloquearia um rebuild
  // real, e vice-versa), não lê nem escreve tabela nenhuma. Staff-gated pelo authorizeCronOrStaff acima.
  //
  // ⚠️ LENDO O RESULTADO: só é canária se a resposta tiver `"canary":true`. Um deploy ANTERIOR a esta
  // fatia não conhece o param, ignora o `?canary=1` e roda um REBUILD REAL (escrita: lease + 6909 upserts,
  // idempotente e guardado, mas é o ciclo completo) devolvendo `{"ok":true,"upserted":...}`. Ou seja:
  // resposta SEM `canary:true` = a canária NÃO rodou E o deploy é velho — que é, em si, o veredito.
  if (new URL(req.url).searchParams.get('canary') === '1') {
    const HUNTER_FIX = '00000000-0000-4000-8000-0000000000ff';
    const membrosFix = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    const clientesFix: OmieClienteRow[] = [
      { customer_user_id: membrosFix[0], omie_codigo_vendedor: 111 }, // limpo → 1 vendedor
      { customer_user_id: membrosFix[1], omie_codigo_vendedor: 222 }, // CONFLITO → 2 vendedores
    ];
    const mapFix: VendedorMapRow[] = [
      { omie_codigo_vendedor: 111, user_id: '00000000-0000-4000-8000-00000000000a' },
      { omie_codigo_vendedor: 222, user_id: '00000000-0000-4000-8000-00000000000a' },
      { omie_codigo_vendedor: 222, user_id: '00000000-0000-4000-8000-00000000000b' },
    ];
    const out = computeCarteira(clientesFix, mapFix, HUNTER_FIX);
    const conflitado = out.assignments.find((a) => a.customer_user_id === membrosFix[1]) ?? null;
    const cobertura = verificarCobertura(membrosFix, out.assignments);
    const resolved = {
      membroConflitadoPresente: conflitado !== null,
      conflitadoSource: conflitado?.source ?? null,
      conflitadoEligible: conflitado?.eligible ?? null,
      conflitadoCodigo: conflitado?.omie_codigo_vendedor ?? null,
      conflictsRegistrados: out.conflicts.length,
      coberturaOk: cobertura.ok,
    };
    const expected = {
      membroConflitadoPresente: true,
      conflitadoSource: 'hunter_orphan',
      conflitadoEligible: false,
      conflitadoCodigo: 222,
      conflictsRegistrados: 1,
      coberturaOk: true,
    };
    const ok = (Object.keys(expected) as Array<keyof typeof expected>)
      .every((k) => resolved[k] === expected[k]);
    if (!ok) {
      console.error('[carteira-rebuild] CANÁRIA VERMELHA — deploy servido diverge do repo:', JSON.stringify({ resolved, expected }));
    }
    return new Response(JSON.stringify({ canary: true, ok, resolved, expected }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Flag de bootstrap: ?bootstrap=1 autoriza gravar quando não há baseline saudável (ou resetá-lo numa queda
  // legítima grande). Gated em service_role/cron-secret — NÃO staff comum (Codex R3 #2: employee comprometido
  // não força bootstrap destrutivo). O cron ROTINEIRO chama sem o param → nunca faz bootstrap nem destrava a catraca.
  const autorizado = new URL(req.url).searchParams.get('bootstrap') === '1'
    && (auth.via === 'service_role' || auth.via === 'cron');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // LEASE anti-intercalação (fecha o mosaico rebuild × rebuild — spec 2026-07-13, Codex xhigh). run_id via
  // crypto.randomUUID() (não Date.now(): sem colisão). Claim ANTES de qualquer leitura/baseline (Codex #5:
  // travar tarde deixaria dois runs lerem baselines diferentes e o mais lento sobrescrever o mais novo,
  // burlando a catraca). Lease ocupado → 409 fail-closed, sem ler nem escrever. Advisory de SESSÃO via
  // PostgREST NÃO serve (o pool não dá afinidade de conexão) → lease row-based (claim_carteira_rebuild).
  const runId = crypto.randomUUID();
  const claimRes = await supabase.rpc('claim_carteira_rebuild', { p_run_id: runId });
  if (claimRes.error) { console.error('[carteira-rebuild] claim erro:', claimRes.error.message); return fail(`claim: ${claimRes.error.message}`); }
  if (claimRes.data !== true) {
    console.warn('[carteira-rebuild] lease ocupado — outro rebuild em andamento; abortando 409 (fail-closed)');
    return fail('rebuild em andamento (lease ocupado)', 409);
  }

  // Libera o lease com OWNERSHIP (a RPC só fecha se ESTE run ainda é dono). Idempotente (flag). await sempre
  // (Codex #3: NÃO best-effort silencioso). retorno 'ownership'/'transport' = incidente (console.error). Os
  // aborts de guard liberam via failLease; uma exceção não-capturada (rara) conta com o auto-expiry de 15min
  // (mesmo backstop de crash — Codex #3: lease preso ≤15min é aceitável, fail-closed).
  let leaseReleased = false;
  const releaseLease = async (status: 'complete' | 'error'): Promise<'ok' | 'ownership' | 'transport'> => {
    if (leaseReleased) return 'ok';   // já liberado COM SUCESSO — a flag marca só no 'ok' (Codex: "iniciado" ≠ "liberado")
    for (let attempt = 1; attempt <= 2; attempt++) {   // retry curto; a RPC é IDEMPOTENTE p/ o mesmo run_id (finalize repetido → true)
      const { data, error } = await supabase.rpc('finalizar_carteira_rebuild', { p_run_id: runId, p_status: status });
      if (error) { console.error(`[carteira-rebuild] finalize transporte (tent ${attempt}):`, error.message); continue; }
      if (data !== true) { console.error('[carteira-rebuild] finalize SEM ownership (fencing quebrado/lease adulterado?):', runId); return 'ownership'; }
      leaseReleased = true;
      return 'ok';
    }
    return 'transport';
  };
  // Abort pós-claim: libera o lease ('error') ANTES de responder o fail (senão fica preso até o TTL).
  const failLease = async (msg: string, status = 500): Promise<Response> => {
    await releaseLease('error');
    return fail(msg, status);
  };

  // 1. Carregar mapa + hunter (tabelas pequenas). FAIL-CLOSED: erro de leitura estrutural aborta ANTES
  // de qualquer upsert — senão vendedorMap=[] mandaria a carteira inteira pro Hunter (P1.4 Codex).
  const [mapRes, hunterRes, baselineRes] = await Promise.all([
    // account-scoped (D1): o código do vendedor PERTENCE à conta Omie — o mesmo humano tem número
    // diferente em cada conta. A proof já fixa account='oben' (:338); ler o map de TODAS as contas era
    // join entre namespaces incompatíveis. Sem o filtro, um código oben que casasse com UMA linha
    // colacor/colacor_sc de OUTRO vendedor resolveria users.size===1 → source='omie', eligible=true,
    // vendedor ERRADO e sem sinal de conflito (misatribuição silenciosa — pior que stale, porque é
    // invisível). Com o filtro, UNIQUE(omie_account, omie_codigo_vendedor) garante que DENTRO da conta
    // código→vendedor é FUNÇÃO ⇒ o ramo 'conflict' de mapeamento fica inalcançável por construção do
    // BANCO. Provado no-op pré-deploy por equivalência de entrada (0/4 códigos do domínio divergem).
    supabase.from('omie_vendedor_map').select('omie_codigo_vendedor, user_id').eq('omie_account', 'oben'),
    supabase.from('company_config').select('value').eq('key', 'carteira_hunter_user_id').maybeSingle(),
    supabase.from('company_config').select('value').eq('key', 'carteira_omie_baseline').maybeSingle(),
  ]);
  if (mapRes.error) { console.error('[carteira-rebuild] load vendedor_map error:', mapRes.error.message); return await failLease(`vendedor_map: ${mapRes.error.message}`); }
  if (hunterRes.error) { console.error('[carteira-rebuild] load hunter error:', hunterRes.error.message); return await failLease(`hunter: ${hunterRes.error.message}`); }
  if (baselineRes.error) { console.error('[carteira-rebuild] load baseline error:', baselineRes.error.message); return await failLease(`baseline: ${baselineRes.error.message}`); }
  // Baseline saudável persistido (omie elegível do último rebuild bom). Ausente → 0 (bootstrap). Valor CORROMPIDO
  // (não-decimal / > 2^53) → ABORTA (Codex R3 P2: não deixar "4797lixo"→4797, "1e9"→1, gigante→Infinity/congelar).
  const baselinePersistido = parseBaselineSaudavel((baselineRes.data?.value as string | null | undefined) ?? '0');
  if (baselinePersistido === null) { console.error('[carteira-rebuild] baseline corrompido:', baselineRes.data?.value); return await failLease(`baseline corrompido: ${baselineRes.data?.value}`); }
  const vendedorMap = (mapRes.data ?? []) as VendedorMapRow[];
  // vendedor_map oben vazio é anômalo (sempre há vendedores oben) e mandaria todos pro Hunter → aborta.
  if (vendedorMap.length === 0) { console.error('[carteira-rebuild] vendedor_map oben vazio — abortando'); return await failLease('vendedor_map oben vazio (anômalo)'); }
  // value pode vir como uuid puro ou JSON-quoted ("uuid") — normaliza removendo aspas.
  const rawHunter = (hunterRes.data?.value as string | null | undefined) ?? null;
  const hunterUserId = rawHunter ? (rawHunter.replace(/^"|"$/g, '').trim() || null) : null;
  // FAIL-CLOSED (D3): sem Hunter o helper não consegue emitir órfão NEM quarantinado (owner_user_id é NOT
  // NULL) → esses membros sumiriam da saída e o upsert-only (:403, sem DELETE) manteria o assignment ANTIGO
  // vivo. Hoje isso são ~4162 membros (2069+2093 hunter_orphan): um cliente que ERA omie→V e perdeu o código
  // continuaria com V elegível, cobrando comissão. Nenhum guard pegava: os de cardinalidade contam LINHAS e
  // o omitido some sem mudar contagem; avaliarGuardResultado só olha omie elegível, que segue intacto.
  // Mesmo padrão do guard de vendedor_map vazio acima. No-op hoje (Hunter configurado no company_config).
  if (!hunterUserId) { console.error('[carteira-rebuild] carteira_hunter_user_id ausente/vazio — abortando'); return await failLease('carteira_hunter_user_id ausente (órfãos e conflitos ficariam sem row → assignment antigo STALE)'); }

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
      if (error) { console.error('[carteira-rebuild] load aliases error:', error.message); return await failLease(`aliases: ${error.message}`); }
      const page = (data ?? []) as Array<{ alias_user_id: string; canonical_user_id: string }>;
      for (const r of page) if (r.alias_user_id && r.canonical_user_id) aliasMap.set(r.alias_user_id, r.canonical_user_id);
      if (page.length < PAGE) break;
    }
  }

  // LISTA de membros = carteira_membership_ledger (P0-B-bis Fatia 1). Acumulador durável (append-only:
  // backfill + trigger AFTER INSERT no espelho; CASCADE só em delete de auth.users) → cobertura monotônica,
  // nunca encolhe → sem stale. Preserva a herança B-lite (gêmeo + clones no mesmo grupo) E a cobertura. O
  // VENDEDOR vem da proof oben (abaixo), não daqui. identity_state vem JUNTO (Fatia 2): o não-'verified'
  // é QUARANTINADO — sai da elegibilidade, NUNCA da lista (tirá-lo daqui faria o upsert-only preservar o
  // assignment antigo STALE — o furo que refutou o A′). Populado pelo omie-analytics-sync no run oben.
  // Paginação robusta a max_rows (#7 Codex): avança pela quantidade REAL retornada e para na página VAZIA
  // — não presume PAGE=1000 (se o servidor capar em 500, `< PAGE` truncaria na 1ª página). Guard anti-loop.
  // user_id é PK NOT NULL no ledger → sem o `.not(is null)` do espelho.
  const PAGE = 1000;
  const MAX_ROWS = 500_000;
  const membroIds: string[] = [];
  const ledgerRows: Array<{ user_id: string; identity_state: string | null }> = [];
  for (let from = 0; ;) {
    const { data, error } = await supabase
      .from('carteira_membership_ledger')
      .select('user_id, identity_state')
      .order('user_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('[carteira-rebuild] load ledger error:', error.message); return await failLease(error.message); }
    const page = (data ?? []) as Array<{ user_id: string; identity_state: string | null }>;
    for (const r of page) { membroIds.push(r.user_id); ledgerRows.push(r); }
    if (page.length === 0) break;
    from += page.length;
    if (from > MAX_ROWS) { console.error('[carteira-rebuild] ledger excedeu MAX_ROWS'); return await failLease('paginacao ledger excedeu limite'); }
  }
  const quarantinados = extrairQuarantinados(ledgerRows);
  if (quarantinados.size > 0) {
    console.warn(`[carteira-rebuild] Fatia 2: ${quarantinados.size} membro(s) QUARANTINADO(s) (identity_state != verified) — preservados, eligible=false, zero comissão`);
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
    if (error) { console.error('[carteira-rebuild] load proof oben error:', error.message); return await failLease(`proof oben: ${error.message}`); }
    const page = (data ?? []) as Array<{ user_id: string; omie_codigo_vendedor: number | string | null }>;
    for (const r of page) {
      const cod = coerceCodigoVendedor(r.omie_codigo_vendedor);
      proofOben.set(r.user_id, cod);
      if (cod != null) comVendedor++;
    }
    if (page.length === 0) break;
    from += page.length;
    if (from > MAX_ROWS) { console.error('[carteira-rebuild] proof oben excedeu MAX_ROWS'); return await failLease('paginacao proof oben excedeu limite'); }
  }

  // Denominador do guard de frescor = proof oben CRUA (sem TTL), não o espelho misto (#4 Codex): isola a
  // degradação por TTL/sync. A carteira ATUAL NÃO entra no guard (Codex R3 #1: o comparativo é SÓ vs o baseline
  // persistido — senão baseline=0 && atual>0, após uma persistência falha, reabriria a catraca).
  const { count: proofCruaRaw, error: cruaErr } = await supabase
    .from('omie_customer_account_map').select('*', { count: 'exact', head: true }).eq('account', 'oben').not('user_id', 'is', null);
  if (cruaErr) { console.error('[carteira-rebuild] count proof crua error:', cruaErr.message); return await failLease(`proof crua: ${cruaErr.message}`); }
  const proofCrua = proofCruaRaw ?? 0;

  // Guard PRÉ-compute fail-closed: proof oben anômala → aborta ANTES de qualquer upsert (senão a carteira
  // zeraria p/ Hunter silenciosamente). Análogo ao guard de vendedor_map vazio (:155).
  const guardPre = avaliarGuardProof({ proofCrua, proofFresca: proofOben.size, comVendedor });
  if (guardPre.abortar) { console.error('[carteira-rebuild] guard proof oben:', guardPre.motivo); return await failLease(`guard proof oben: ${guardPre.motivo}`); }

  // Merge: LISTA (ledger) × VENDEDOR (proof oben). Clone ausente da proof → null → herda do gêmeo no grupo.
  const clientes = montarClientes(membroIds, proofOben);

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
      if (error) { console.error('[carteira-rebuild] load flaggeds error:', error.message); return await failLease(`flaggeds: ${error.message}`); }
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
    return await failLease(`cadeia de alias (${chainViolations.length}) — corrija customer_canonical_alias`);
  }

  // 2c. Rows finais — eligible EXPLÍCITO pós-máscaras (clone a.eligible E não-fornecedor E não-quarantinado:
  // é o que esconde os clones / reativa no rollback / retira fornecedor / neutraliza identidade ambígua).
  // Conserta o bug do upsert que omitia eligible. Máscara = elegibilidade, nunca presença (todo membro do
  // ledger sai com row → reconciliado, nada stale).
  const now = new Date().toISOString();
  const rows = aplicarMascaras(assignments, flaggeds, quarantinados).map((a) => ({
    customer_user_id: a.customer_user_id,
    owner_user_id: a.owner_user_id,
    source: a.source,
    omie_codigo_vendedor: a.omie_codigo_vendedor,
    eligible: a.eligible,
    updated_at: now,
    last_synced_at: now,
  }));

  // 2c-bis. PÓS-CONDIÇÃO DE COBERTURA (D4) — a saída cobre EXATAMENTE os membros do ledger. Prova o CONJUNTO;
  // os guards abaixo contam LINHAS e são CEGOS ao membro omitido (ele some sem mudar contagem nenhuma). Como o
  // upsert é upsert-only (:403, onConflict customer_user_id, sem DELETE), TODA omissão vira assignment ANTIGO
  // vivo — vendedor errado, elegível, cobrando comissão (o furo que refutou o A′). Tripwire: com o filtro de
  // conta + a quarentena do conflito + o guard do Hunter, isto deve ser INALCANÇÁVEL; se disparar, computeCarteira
  // tem bug e o certo é NÃO escrever. Roda sobre `rows` (o payload real do upsert), não sobre `assignments`.
  const cobertura = verificarCobertura(membroIds, rows);
  if (!cobertura.ok) { console.error('[carteira-rebuild] pós-condição de cobertura:', cobertura.motivo); return await failLease(`cobertura: ${cobertura.motivo}`); }

  // 2d. Guard PÓS-compute (Codex R1-R3): conta só omie ELEGÍVEL (#3); BLOQUEIA o bootstrap quando o baseline
  // PERSISTIDO é 0 sem ?bootstrap=1 — INDEPENDENTE da carteira atual (R3 #1); compara SÓ com o baseline persistido
  // (fator 0.8, monotônico → sem catraca). Nunca grava carteira integralmente órfã.
  const omieElegivelNovo = rows.filter((r) => r.source === 'omie' && r.eligible).length;
  const guardPos = avaliarGuardResultado({ omieElegivelNovo, baselinePersistido, autorizado });
  if (guardPos.abortar) { console.error('[carteira-rebuild] guard resultado:', guardPos.motivo); return await failLease(`guard resultado: ${guardPos.motivo}`); }

  // 3. Upsert idempotente.

  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    // Retry idempotente do chunk (Codex re-challenge): o upsert é idempotente por customer_user_id → re-tentar
    // reduz o mosaico por erro TRANSITÓRIO. Erro persistente ainda deixa parcial (reportado honesto abaixo); o
    // reparo total (staging + swap atômico = opção B) é dívida v2.
    let chunkErr: { message: string } | null = null;
    let chunkStatus = 0;
    for (let tent = 1; tent <= 3; tent++) {
      const { error, status } = await supabase.from('carteira_assignments').upsert(chunk, { onConflict: 'customer_user_id' });
      if (!error) { chunkErr = null; break; }
      chunkErr = error; chunkStatus = status ?? 0;
      console.warn(`[carteira-rebuild] upsert chunk ${i} falhou (tent ${tent}, http ${chunkStatus}):`, error.message);
    }
    if (chunkErr) {
      // Upsert parcial (chunks anteriores JÁ commitaram — PostgREST = 1 tx/chunk). Codex re-challenge #4: NÃO
      // declarar writes_committed:false sob RESPOSTA PERDIDA. `status:0` do SDK = falha de fetch → o chunk PODE
      // ter commitado (commit DESCONHECIDO); `status>=400` = o banco recusou (chunk NÃO commitou). Reporte:
      // upserted_confirmed (só chunks que retornaram ok) + current_chunk_commit. Propaga ownership/transport do
      // finalize. Reparo total (staging + swap atômico = opção B) é dívida v2.
      const commitDesconhecido = chunkStatus === 0;
      console.error(`[carteira-rebuild] upsert parcial (chunk ${i}, http ${chunkStatus}, commit ${commitDesconhecido ? 'DESCONHECIDO' : 'nao'}):`, chunkErr.message);
      const rel = await releaseLease('error');
      const base = {
        ok: false, error: chunkErr.message, runId,
        upserted_confirmed: upserted,                                  // só os chunks que retornaram sucesso
        current_chunk_commit: commitDesconhecido ? 'unknown' : 'no',
        writes_committed: upserted > 0 || commitDesconhecido,          // honesto: transporte pode ter escrito
        partial: upserted > 0 || commitDesconhecido,
      };
      const body = rel === 'ownership' ? { ...base, ownership_lost: true, integrity: 'unknown' }
                 : rel === 'transport' ? { ...base, finalize: 'unknown' }
                 : base;
      // 503 se o commit do chunk é incerto (transporte) OU o finalize teve transporte; 500 no erro real de banco.
      const httpStatus = (commitDesconhecido || rel === 'transport') ? 503 : 500;
      return new Response(JSON.stringify(body), { status: httpStatus, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
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

  // Finalize honesto do lease. 'ownership' e 'transport' são DISTINTOS (Codex #3):
  const finalize = await releaseLease('complete');
  if (finalize === 'ownership') {
    // perdeu o lease no FIM = fencing quebrado ou lease adulterado → integridade DESCONHECIDA. NÃO é
    // transitório nem retentável (500, distinto do 503 de transporte). A escrita saiu, mas outro run pode
    // ter concorrido: alerta forte.
    console.error('[carteira-rebuild] OWNERSHIP perdido no finalize (integridade desconhecida):', runId);
    return new Response(JSON.stringify({
      ok: false, error: 'ownership perdido no finalize', ownership_lost: true, integrity: 'unknown',
      writes_committed: true, upserted, omieElegivelNovo, novoBaseline: guardPos.novoBaseline, runId,
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  if (finalize === 'transport') {
    // transporte falhou APÓS o upsert commitado → 503 honesto (writes_committed:true, finalize:'unknown').
    // A escrita ESTÁ boa; só o selo do lease ficou incerto. O lease auto-expira em 15min (fail-closed; sem
    // force-release, sem reduzir TTL).
    return new Response(JSON.stringify({
      ok: false, error: 'finalize falhou (transporte)', writes_committed: true, finalize: 'unknown',
      upserted, omieElegivelNovo, novoBaseline: guardPos.novoBaseline, runId,
    }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    ok: true, upserted, orphanCount, omieElegivelNovo, comVendedor,
    proofFresca: proofOben.size, proofCrua, baselinePersistido, novoBaseline: guardPos.novoBaseline,
    autorizado, via: auth.via, conflicts, hunterUserId, aliasesAtivos: aliasMap.size, runId,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
