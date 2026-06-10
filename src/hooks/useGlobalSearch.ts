import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { ilikeOr } from '@/lib/postgrest';

/**
 * Busca global pra Cmd-K — pesquisa simultânea em 3 entidades:
 *  - Clientes (profiles): nome, document, email
 *  - Fórmulas tintométricas (tint_formulas): cor_id, nome_cor
 *  - Pedidos de venda (sales_orders): omie_numero_pedido
 *
 * Debounce 200ms pra evitar flood. Limite 5 por categoria pra UI manter snapshot.
 * Resultados servem pra renderizar grupos no CommandPalette.
 *
 * Recentes: top 10 últimos cliques (path navegado), persistido em localStorage.
 */

export interface SearchResult {
  kind: 'customer' | 'formula' | 'sales-order';
  id: string;
  title: string;
  subtitle?: string;
  path: string;
}

const RECENTS_KEY = 'global_search_recents_v1';
const MAX_RECENTS = 10;

function readRecents(): SearchResult[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as SearchResult[]) : [];
  } catch {
    return [];
  }
}

function writeRecents(items: SearchResult[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(RECENTS_KEY, JSON.stringify(items.slice(0, MAX_RECENTS)));
  window.dispatchEvent(new StorageEvent('storage', { key: RECENTS_KEY }));
}

function useDebouncedValue<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export function useGlobalSearch(query: string, enabled = true) {
  const { isStaff } = useAuth();
  const debouncedQuery = useDebouncedValue(query, 200);
  const trimmed = debouncedQuery.trim();
  // Gate por isStaff — busca expõe profiles (PII) e sales_orders. Customer não
  // tem caso de uso pra essas entidades; gate evita enumeração + reduz custo.
  const isActive = enabled && isStaff && trimmed.length >= 2;

  /* ─── Customers ─── */
  const customersQuery = useQuery<SearchResult[]>({
    queryKey: ['gs-customers', trimmed],
    enabled: isActive,
    staleTime: 30_000,
    queryFn: async () => {
      // Busca por nome OU document OU email — ilikeOr sanitiza (anti-injeção)
      const { data } = await supabase
        .from('profiles')
        .select('user_id, name, document, email')
        .or(ilikeOr(['name', 'document', 'email'], trimmed))
        .limit(5);
      return (data ?? []).map((p): SearchResult => ({
        kind: 'customer',
        id: p.user_id,
        title: p.name ?? 'Sem nome',
        subtitle: p.document ?? p.email ?? undefined,
        // Vai direto pro 360° (dashboard rico), não pra lista com modal genérico
        path: `/admin/customers/${p.user_id}/360`,
      }));
    },
  });

  /* ─── Tint formulas ─── */
  const formulasQuery = useQuery<SearchResult[]>({
    queryKey: ['gs-formulas', trimmed],
    enabled: isActive,
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_formulas')
        .select('id, cor_id, nome_cor')
        .is('desativada_em', null)
        .or(ilikeOr(['cor_id', 'nome_cor'], trimmed))
        .limit(5);
      return (data ?? []).map((f): SearchResult => ({
        kind: 'formula',
        id: f.id,
        title: f.nome_cor ?? f.cor_id ?? 'Sem nome',
        subtitle: f.cor_id ? `Cor ${f.cor_id}` : undefined,
        path: `/tintometrico/formulas?cor=${encodeURIComponent(f.cor_id ?? '')}`,
      }));
    },
  });

  /* ─── Sales orders (busca por número PV) ─── */
  // Só faz query se for puramente numérico (PV é número)
  const isNumericQuery = /^\d+$/.test(trimmed);
  const ordersQuery = useQuery<SearchResult[]>({
    queryKey: ['gs-orders', trimmed],
    enabled: isActive && isNumericQuery,
    staleTime: 30_000,
    queryFn: async () => {
      // .ilike() único — só wildcards do ILIKE precisam ser strippados
      const q = trimmed.replace(/[%_]/g, '');
      const { data } = await supabase
        .from('sales_orders')
        .select('id, omie_numero_pedido, total, customer_user_id')
        .ilike('omie_numero_pedido', `%${q}%`)
        .limit(5);
      return (data ?? []).map((o: { id: string; omie_numero_pedido: string | null; total: number | null }): SearchResult => ({
        kind: 'sales-order',
        id: o.id,
        title: `PV ${(o.omie_numero_pedido ?? '').replace(/^0+/, '') || o.id.slice(0, 8)}`,
        subtitle: o.total
          ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(o.total)
          : undefined,
        path: `/sales/edit/${o.id}`,
      }));
    },
  });

  const isLoading = isActive && (customersQuery.isFetching || formulasQuery.isFetching || ordersQuery.isFetching);

  const groups = useMemo(() => {
    const out: Array<{ heading: string; results: SearchResult[] }> = [];
    if (customersQuery.data?.length) out.push({ heading: 'Clientes', results: customersQuery.data });
    if (formulasQuery.data?.length) out.push({ heading: 'Fórmulas tintométricas', results: formulasQuery.data });
    if (ordersQuery.data?.length) out.push({ heading: 'Pedidos de venda', results: ordersQuery.data });
    return out;
  }, [customersQuery.data, formulasQuery.data, ordersQuery.data]);

  return {
    isActive,
    isLoading,
    groups,
    hasResults: groups.length > 0,
  };
}

/** Hook standalone pra ler/atualizar recentes (consumido pela palette). */
export function useSearchRecents() {
  const [recents, setRecents] = useState<SearchResult[]>(() => readRecents());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === RECENTS_KEY || e.key === null) setRecents(readRecents());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const push = (result: SearchResult) => {
    setRecents((prev) => {
      // Move to top, dedupe por path
      const next = [result, ...prev.filter((r) => r.path !== result.path)].slice(0, MAX_RECENTS);
      writeRecents(next);
      return next;
    });
  };

  const clear = () => {
    writeRecents([]);
    setRecents([]);
  };

  return { recents, push, clear };
}
