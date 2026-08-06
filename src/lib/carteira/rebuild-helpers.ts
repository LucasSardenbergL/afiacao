// src/lib/carteira/rebuild-helpers.ts
import type { CarteiraSource } from '@/types/carteira';

export interface OmieClienteRow {
  customer_user_id: string;
  omie_codigo_vendedor: number | null;
}

export interface VendedorMapRow {
  omie_codigo_vendedor: number;
  user_id: string;
}

export interface ComputedAssignment {
  customer_user_id: string;
  owner_user_id: string;
  source: CarteiraSource;
  omie_codigo_vendedor: number | null;
  /** Visível na carteira/tela. Clones canonicalizados (B-lite) → false (escondidos, preservados). */
  eligible: boolean;
}

export interface MappingConflict {
  customer_user_id: string;
  omie_codigo_vendedor: number;
  candidate_user_ids: string[];
}

export interface RebuildResult {
  assignments: ComputedAssignment[];
  conflicts: MappingConflict[];
  orphanCount: number;
  /** Aliases cujo canônico é ele mesmo um alias (cadeia A→B→C). NÃO-VAZIO = o caller deve ABORTAR. */
  chainViolations: string[];
}

type Resolved =
  | { kind: 'omie'; user: string; code: number }
  | { kind: 'conflict'; code: number; users: string[] }
  | { kind: 'orphan'; code: number | null };

/**
 * Deriva os assignments de carteira a partir do mapeamento Omie (PURO, sem I/O).
 *
 * `aliasMap` (clone→canônico, consolidação B-lite, spec 2026-06-13): canonicaliza o clone (cadastro
 * Colacor SC sem nome) no gêmeo (cadastro Oben com nome). Map VAZIO → comportamento idêntico ao legado
 * + `eligible=true` explícito (conserta o bug do upsert que omitia `eligible`).
 *
 * Regra por GRUPO canônico (determinístico — clientes ordenados por id):
 * - **Grupo limpo** (≤1 vendedor distinto, sem conflito de mapeamento): o canônico fica `eligible=true`
 *   com o vendedor herdado (ou Hunter se órfão); os clones do grupo ficam `eligible=false` (escondidos).
 * - **Conflito** (≥2 vendedores distintos no grupo, OU código→2 vendedores no map): NÃO canonicaliza —
 *   processa CADA membro como legado (todos `eligible=true`, dono próprio). NUNCA esconde um membro sem
 *   unificar (evita "cliente some" / estado stale) + registra em `conflicts`. Membro com conflito de
 *   MAPEAMENTO é QUARANTINADO (Hunter inerte + `eligible=false`), nunca omitido — omitir + upsert-only
 *   deixaria o assignment antigo vivo (stale). O caller real torna esse ramo inalcançável filtrando o
 *   `omie_vendedor_map` por conta (`UNIQUE(omie_account, omie_codigo_vendedor)` ⇒ código→vendedor é função
 *   DENTRO da conta); o helper é puro e não pode CONFIAR nisso — daí a quarentena defensiva.
 *
 * `chainViolations` não-vazio (canônico que também é alias) → o caller deve abortar o rebuild.
 */
// MIRROR-START carteira-compute — computeCarteira espelhado verbatim de src/lib/carteira/rebuild-helpers.ts (P0-B-bis)
export function computeCarteira(
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

// ── P0-B-bis: o carteira-rebuild lê a LISTA de membros do carteira_membership_ledger (Fatia 1, acumulador)
// e o VENDEDOR da PROOF oben omie_customer_account_map_fresco(account='oben') — nem lista nem vendedor vêm
// mais do espelho poluído omie_clientes. A lista preserva a herança B-lite (gêmeo + clones). As 4 funções
// são ESPELHADAS verbatim no edge (Deno não importa de src/) — paridade textual no canário edge-money-path.
// Guards fail-closed endurecidos após o Codex challenge (8 P1):
//   • coerceCodigoVendedor: SÓ decimal canônico (regex ^[0-9]+$ + BigInt) antes de virar number — rejeita
//     hex/exponencial/decimal-lossy/sinal/espaços (P2 Codex); positivo e ≤ 2^53 (0/neg/>2^53 = null).
//   • montarClientes: merge LISTA×VENDEDOR preservando a ordem do espelho (clone ausente da proof → null).
//   • avaliarGuardProof (PRÉ-compute): aborta se proof oben fresca vazia / < 50% da proof CRUA (denominador
//     é a própria proof, não o espelho misto — corrige o falso-positivo #4) / 0 vendedores não-null.
//   • avaliarGuardResultado (PÓS-compute): aborta se 0 omie ELEGÍVEL. CRON (não-autorizado): compara
//     omieElegivelNovo SÓ com o BASELINE PERSISTIDO (fator 0.8, monotônico → sem catraca; a carteira atual fica
//     FORA — Codex R3: se a persistência do baseline falha (0), o cron fica fail-closed). BOOTSTRAP (autorizado):
//     mede a SAÍDA vs max(carteira ATUAL omie elegível, baseline persistido) — encolher < 80% exige &force=1
//     (R4b: o max impede erodir o baseline em etapas quando atual<baseline). Fecha o furo Codex R4 (o >0 sozinho
//     gravava ~Hunter na perda de vendedor grande / flaggeds-consolidação em massa / corrupção de 1 código). A
//     carteira atual entra SÓ no ramo autorizado → não reabre a catraca do cron. Retorna o novoBaseline.
//   • parseBaselineSaudavel: valida o baseline lido do company_config (decimal canônico ≤ 2^53); inválido → null
//     (o edge ABORTA em vez de virar valor inseguro — "4797lixo"→null, "1e9"→null, gigante→null).
// MIRROR-START carteira-load — espelhado verbatim em supabase/functions/carteira-rebuild/index.ts
export function coerceCodigoVendedor(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null;
  const b = BigInt(raw);
  return b > 0n && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : null;
}
export function montarClientes(espelhoIds: string[], proofOben: Map<string, number | null>): OmieClienteRow[] {
  return espelhoIds.map((customer_user_id) => ({
    customer_user_id,
    omie_codigo_vendedor: proofOben.get(customer_user_id) ?? null,
  }));
}
export function extrairQuarantinados(rows: Array<{ user_id: string; identity_state: string | null }>): Set<string> {
  // FAIL-CLOSED (Fatia 2 D2): quarantina tudo que não for EXATAMENTE 'verified' — inclui null, estado
  // futuro e qualquer valor que o CHECK venha a aceitar. A Fatia 2 só POPULA 'ambiguous', mas testar
  // `=== 'ambiguous'` falharia ABERTO (cliente de identidade dúbia pagando comissão) no dia em que outro
  // estado ganhasse gatilho. Ledger vazio → set vazio → rebuild degrada p/ o comportamento de hoje.
  const quarantinados = new Set<string>();
  for (const r of rows) if (r.identity_state !== 'verified') quarantinados.add(r.user_id);
  return quarantinados;
}
export function aplicarMascaras(
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
export function verificarCobertura(
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
export function avaliarGuardProof(m: { proofCrua: number; proofFresca: number; comVendedor: number }): { abortar: boolean; motivo: string | null } {
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
export function avaliarGuardResultado(m: { omieElegivelNovo: number; baselinePersistido: number; autorizado: boolean; omieAtual: number; forcado: boolean }): { abortar: boolean; motivo: string | null; novoBaseline: number } {
  if (m.omieElegivelNovo === 0) {
    return { abortar: true, motivo: '0 assignments omie elegiveis (carteira 100% Hunter) — abortado p/ preservar', novoBaseline: m.baselinePersistido };
  }
  if (m.autorizado) {
    // BOOTSTRAP mede a SAIDA (omieElegivelNovo POS consolidacao/conflitos/flaggeds), nao a fonte (Codex R4 P1.1-3):
    // o >0 sozinho gravaria carteira ~Hunter se o vendedor_map dessincronizasse (perda de um vendedor grande),
    // flaggeds/consolidacao em massa destruissem a saida, OU corrupcao deixasse so 1 codigo valido. Trava vs a
    // REFERENCIA = max(carteira ATUAL omie elegivel, baseline persistido): o MAIOR sinal saudavel (Codex R4b P2:
    // usar so a atual permitia erodir o baseline em etapas quando atual<baseline; com o max, &force=1 vira o UNICO
    // jeito de baixar o baseline, e a primeira populacao TRUNCADA com baseline>0 fica protegida). Encolher < 80%
    // da ref exige &force=1. A ref entra SO neste ramo autorizado -> NAO reabre a catraca do cron (so-baseline, R3).
    // Primeira populacao SEM historico (ref=0): so o >0 protege (carteira nascendo; operador confere os contadores).
    const ref = Math.max(m.omieAtual, m.baselinePersistido);
    if (!m.forcado && ref > 0 && m.omieElegivelNovo < 0.8 * ref) {
      return { abortar: true, motivo: `bootstrap encolheria omie elegivel p/ ${m.omieElegivelNovo} (< 80% de ${ref} = max[atual ${m.omieAtual}, baseline ${m.baselinePersistido}]) — investigue vendedor_map/proof ou &force=1 se a queda e legitima`, novoBaseline: m.baselinePersistido };
    }
    // Sem force o baseline persiste MONOTONICO sobre as TRES grandezas (atual, baseline, novo) — nunca desce.
    // O omieAtual PRECISA entrar no max (Codex R5 P1): com baseline DESATUALIZADO (0) e carteira real 2747, um
    // max(baseline, novo) persistiria 2198 e ESQUECERIA os 2747 — o run seguinte compararia com 2198 e deixaria
    // cair p/ 1759 (erosao acumulada de 36% sem force). Incluindo o atual, o baseline vira 2747 e o 2º passo
    // aborta. COM force o reset legitimo assume a queda e grava o novo valor (o UNICO jeito de baixar).
    return { abortar: false, motivo: null, novoBaseline: m.forcado ? m.omieElegivelNovo : Math.max(m.omieAtual, m.baselinePersistido, m.omieElegivelNovo) };
  }
  if (m.baselinePersistido === 0) {
    return { abortar: true, motivo: 'bootstrap (baseline persistido=0) exige autorizacao explicita — cron nao faz bootstrap', novoBaseline: 0 };
  }
  if (m.omieElegivelNovo < 0.8 * m.baselinePersistido) {
    return { abortar: true, motivo: `regressao: omie elegivel novo (${m.omieElegivelNovo}) < 80% do baseline saudavel (${m.baselinePersistido})`, novoBaseline: m.baselinePersistido };
  }
  return { abortar: false, motivo: null, novoBaseline: Math.max(m.baselinePersistido, m.omieElegivelNovo) };
}
export function parseBaselineSaudavel(raw: string | null | undefined): number | null {
  if (raw == null || !/^[0-9]+$/.test(raw)) return null;
  const b = BigInt(raw);
  return b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : null;
}
// MIRROR-END
