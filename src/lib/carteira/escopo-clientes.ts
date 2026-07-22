// Escopo de clientes da tela /admin/customers.
// PUROS + HOFs testáveis aqui; a glue Supabase é anexada na 2ª metade (Task 2).
// Spec: docs/superpowers/specs/2026-06-11-clientes-escopo-carteira-design.md
import { supabase } from '@/integrations/supabase/client';
import { margemConhecida } from '@/lib/scoring/margin';
import type { Customer, ClientScore } from '@/components/adminCustomers/types';

export interface DisplayFlags {
  displayIsMaster: boolean;
  displayIsGestorComercial: boolean;
  displayIsSalesOnly: boolean;
}

/** sales-only é a restrição mais forte (CPF de campo nunca vê a base) → sempre carteira. */
export function resolveModoEscopo(f: DisplayFlags): 'carteira' | 'completa' {
  if (f.displayIsSalesOnly) return 'carteira';
  return f.displayIsMaster || f.displayIsGestorComercial ? 'completa' : 'carteira';
}

export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk: size deve ser > 0');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function marcarCobertura<T extends { user_id: string }>(
  profiles: T[],
  ownerById: Map<string, string>,
  baseId: string | null,
): (T & { coberto_de: string | null })[] {
  return profiles.map((p) => {
    const owner = ownerById.get(p.user_id) ?? null;
    return { ...p, coberto_de: owner && owner !== baseId ? owner : null };
  });
}

export function ordenarPorNome<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    (a.name ?? '').localeCompare(b.name ?? '', 'pt-BR', { sensitivity: 'base' }),
  );
}

/** Pagina via fetchPage(from,to) até a página vir menor que pageSize. */
export async function paginarTudo<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const page = await fetchPage(from, from + pageSize - 1);
    all.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/** Quebra ids em lotes e concatena os resultados, em ordem. Propaga erro de qualquer lote. */
export async function coletarEmLotes<I, O>(
  ids: I[],
  size: number,
  fetchLote: (lote: I[]) => Promise<O[]>,
): Promise<O[]> {
  const out: O[] = [];
  for (const lote of chunk(ids, size)) {
    out.push(...(await fetchLote(lote)));
  }
  return out;
}

/** Hash estável e barato dos IDs visíveis. A contagem sozinha não pega reatribuição
 *  que mantém o tamanho (cliente sai/entra, length igual); o hash muda se qualquer id
 *  mudar. Usado na queryKey dos scores p/ não reusar o map do conjunto anterior. */
export function hashIds(ids: string[]): string {
  let h = 0;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) {
      h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
    }
  }
  return `${ids.length}:${h}`;
}

/** Owners do escopo do ALVO na lente: posse direta + carteiras que ele cobre (ativas e
 *  dentro da validade). `coverageRows` vêm de carteira_coverage já filtradas por active.
 *  Reproduz, com a sessão do master, o que a RLS carteira_visivel_para daria ao alvo. */
export function ownersAtivosDoAlvo(
  coverageRows: { covered_user_id: string; valid_until: string | null }[],
  alvoId: string,
  nowIso: string,
): string[] {
  const cobertos = coverageRows
    .filter((c) => !c.valid_until || c.valid_until > nowIso)
    .map((c) => c.covered_user_id);
  return [alvoId, ...cobertos];
}

const LOTE_IN = 150; // 1000 UUIDs estouram o limite de URL do proxy (≠ cap de linhas do PostgREST)

/**
 * Clientes da carteira. Fonte = carteira_assignments (eligible=true), paginado
 * (select puro capa em 1000). Fora da lente a RLS já escopa pra carteira+cobertura;
 * na lente (sessão é o master → RLS vê tudo) filtra pelo owner do alvo.
 */
export async function fetchCarteiraClientes(opts: {
  isImpersonating: boolean;
  effectiveUserId: string | null;
  baseId: string | null;
}): Promise<{ customers: Customer[]; ids: string[] }> {
  // Na lente a sessão é a do MASTER (RLS vê tudo), então REPRODUZIMOS o escopo do alvo:
  // posse direta + carteiras que o alvo cobre. Fora da lente, a RLS carteira_visivel_para
  // já entrega carteira própria + cobertura — sem filtro de owner aqui.
  let ownerFilter: string[] | null = null;
  if (opts.isImpersonating && opts.effectiveUserId) {
    const { data: cov, error: covErr } = await supabase
      .from('carteira_coverage')
      .select('covered_user_id, valid_until')
      .eq('covering_user_id', opts.effectiveUserId)
      .eq('active', true);
    if (covErr) throw covErr;
    ownerFilter = ownersAtivosDoAlvo(cov ?? [], opts.effectiveUserId, new Date().toISOString());
  }

  const assignments = await paginarTudo<{ customer_user_id: string; owner_user_id: string }>(
    async (from, to) => {
      let q = supabase
        .from('carteira_assignments')
        .select('customer_user_id, owner_user_id')
        .eq('eligible', true);
      if (ownerFilter) {
        q = q.in('owner_user_id', ownerFilter);
      }
      const { data, error } = await q.order('customer_user_id').range(from, to);
      if (error) throw error;
      return data ?? [];
    },
  );

  const ownerById = new Map(
    assignments.map((a) => [a.customer_user_id, a.owner_user_id] as [string, string]),
  );
  const ids = [...ownerById.keys()];
  if (ids.length === 0) return { customers: [], ids };

  const profiles = await coletarEmLotes(ids, LOTE_IN, async (lote) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id, name, email, phone, document, customer_type, created_at, requires_po')
      .in('user_id', lote)
      .eq('is_employee', false);
    if (error) throw error;
    return (data ?? []) as Customer[];
  });

  const customers = ordenarPorNome(marcarCobertura(profiles, ownerById, opts.baseId));
  return { customers, ids };
}

/**
 * Scores por customer_user_id (não por farmer_id): UNIQUE(customer_user_id) garante
 * 1 linha/cliente, conserta scores stale pós-reatribuição e vazios pro gestor/master.
 * A RLS de farmer_client_scores reforça (pode_ver_carteira_completa OR carteira_visivel_para).
 */
export async function fetchScoresPorCustomer(ids: string[]): Promise<Map<string, ClientScore>> {
  const map = new Map<string, ClientScore>();
  if (ids.length === 0) return map;
  const rows = await coletarEmLotes(ids, LOTE_IN, async (lote) => {
    const { data, error } = await supabase
      .from('farmer_client_scores')
      .select('customer_user_id, health_score, health_class, churn_risk, expansion_score, priority_score, avg_monthly_spend_180d, days_since_last_purchase, category_count, gross_margin_pct, avg_repurchase_interval, sales_history_status')
      .in('customer_user_id', lote);
    if (error) throw error;
    return data ?? [];
  });
  for (const s of rows) {
    map.set(s.customer_user_id, {
      customer_user_id: s.customer_user_id,
      health_score: s.health_score ?? 0,
      health_class: s.health_class ?? 'critico',
      churn_risk: s.churn_risk ?? 0,
      expansion_score: s.expansion_score ?? 0,
      priority_score: s.priority_score ?? 0,
      avg_monthly_spend_180d: s.avg_monthly_spend_180d ?? 0,
      days_since_last_purchase: s.days_since_last_purchase ?? 0,
      category_count: s.category_count ?? 0,
      // Sem `?? 0`: margem ausente tem de chegar como null ao consumidor. Coagir aqui tornaria
      // inertes os guards de quem lê este mapa (a armadilha da "correção só no consumidor").
      gross_margin_pct: margemConhecida(s.gross_margin_pct),
      sales_history_status: s.sales_history_status ?? null,
    });
  }
  return map;
}
