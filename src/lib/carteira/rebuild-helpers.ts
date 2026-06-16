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
