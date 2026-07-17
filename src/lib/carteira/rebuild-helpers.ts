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
 *   unificar (evita "cliente some" / estado stale) + registra em `conflicts`. (Membro com conflito de
 *   MAPEAMENTO não é emitido — comportamento legado.)
 *
 * `chainViolations` não-vazio (canônico que também é alias) → o caller deve abortar o rebuild.
 */
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
      if (eligible) orphanCount++; // conta só órfão VISÍVEL (clone escondido não infla a métrica)
      if (hunterUserId) assignments.push({ customer_user_id: c.customer_user_id, owner_user_id: hunterUserId, source: 'hunter_orphan', omie_codigo_vendedor: c.omie_codigo_vendedor ?? null, eligible });
    }
    // v.kind === 'conflict' → não emite (legado): código mapeado p/ 2 vendedores.
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
//   • avaliarGuardResultado (PÓS-compute): aborta se 0 omie ELEGÍVEL (#3); BLOQUEIA o bootstrap quando o
//     BASELINE PERSISTIDO é 0 sem flag — INDEPENDENTE da carteira atual (Codex R3: se a persistência falha,
//     o baseline segue 0 → o cron fica fail-closed); compara SÓ com o baseline persistido (fator 0.8, monotônico
//     → sem catraca). Retorna o novoBaseline a gravar.
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
export function avaliarGuardResultado(m: { omieElegivelNovo: number; baselinePersistido: number; autorizado: boolean }): { abortar: boolean; motivo: string | null; novoBaseline: number } {
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
export function parseBaselineSaudavel(raw: string | null | undefined): number | null {
  if (raw == null || !/^[0-9]+$/.test(raw)) return null;
  const b = BigInt(raw);
  return b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : null;
}
// MIRROR-END
