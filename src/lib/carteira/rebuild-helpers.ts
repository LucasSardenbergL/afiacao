// src/lib/carteira/rebuild-helpers.ts
export type CarteiraSource = 'omie' | 'hunter_orphan';

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
}

/**
 * Deriva os assignments de carteira a partir do mapeamento Omie (PURO, sem I/O).
 * Fase 1: match por código ignorando a conta (omie_clientes não guarda account).
 * Colisão de código entre vendedores distintos vira conflito (não atribui).
 */
export function computeCarteira(
  clientes: OmieClienteRow[],
  vendedorMap: VendedorMapRow[],
  hunterUserId: string | null,
): RebuildResult {
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
        assignments.push({
          customer_user_id: c.customer_user_id,
          owner_user_id: [...users][0],
          source: 'omie',
          omie_codigo_vendedor: code,
        });
        continue;
      }
      conflicts.push({
        customer_user_id: c.customer_user_id,
        omie_codigo_vendedor: code,
        candidate_user_ids: [...users].sort(),
      });
      continue;
    }

    // código null OU não-mapeado → órfão → Hunter
    orphanCount++;
    if (hunterUserId) {
      assignments.push({
        customer_user_id: c.customer_user_id,
        owner_user_id: hunterUserId,
        source: 'hunter_orphan',
        omie_codigo_vendedor: code ?? null,
      });
    }
  }

  return { assignments, conflicts, orphanCount };
}
