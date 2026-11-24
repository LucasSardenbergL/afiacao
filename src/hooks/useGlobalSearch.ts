import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { ilikeContainsPattern, ilikeOr, isSearchablePostgrestTerm } from '@/lib/postgrest';

/**
 * Busca global pra Cmd-K — pesquisa simultânea em 3 entidades:
 *  - Clientes (RPC `buscar_clientes_global`): nome/razão social de qualquer cliente; documento e e-mail
 *    só casam — e só voltam — onde o contato é visível (carteira/cobertura/gestão). Staff nunca aparece.
 *  - Fórmulas tintométricas (tint_formulas): cor_id, nome_cor
 *  - Pedidos de venda (sales_orders): omie_numero_pedido
 *
 * Debounce 200ms pra evitar flood. Limite 5 por categoria pra UI manter snapshot.
 * Resultados servem pra renderizar grupos no CommandPalette.
 *
 * Recentes: top 10 últimos cliques, POR USUÁRIO, só `kind`/`id`/`title`/`path` (nada de documento
 * ou e-mail em localStorage). A chave antiga global (`global_search_recents_v1`, que guardava o
 * subtitle com CPF/CNPJ) é apagada na primeira leitura.
 */

export interface SearchResult {
  kind: 'customer' | 'formula' | 'sales-order';
  id: string;
  title: string;
  subtitle?: string;
  path: string;
}

/**
 * O MESMO `kind`, dito na língua do PostHog.
 *
 * O tipo acima é kebab-case porque é o idioma natural de um union em TS; o payload de evento é
 * snake_case por convenção (`has_subtitle`, `total_eligible`). Mandar `r.kind` cru para o
 * `track()` não muda a tela e não movia o `tsc` — quebraria a continuidade da série, e é por isso
 * que o gate de `@/lib/analytics` recusa literal hifenizado no payload.
 *
 * A tabela mora AQUI, junto do tipo que dona o vocabulário — mapa artesanal dentro de cada
 * componente é como duas grafias do mesmo valor passam a coexistir (foi assim que `sem-rede` e
 * `sem_rede` se separaram; ver `docs/agent/money-path.md`). `satisfies` faz a exaustividade:
 * `kind` novo não compila até alguém dizer como ele se chama na série, em vez de mandar
 * `undefined` para o PostHog.
 */
export const KIND_NA_SERIE = {
  customer: 'customer',
  formula: 'formula',
  'sales-order': 'sales_order',
} as const satisfies Record<SearchResult['kind'], string>;

/** Chave antiga (global, com subtitle = documento/e-mail). Só existe para ser APAGADA. */
export const CHAVE_RECENTES_LEGADA = 'global_search_recents_v1';
const PREFIXO_RECENTES = 'global_search_recents_v2:';
const MAX_RECENTS = 10;

export const chaveRecentes = (userId: string) => `${PREFIXO_RECENTES}${userId}`;

/** O que pode ir para o localStorage: identidade + destino. Nunca subtitle (documento/e-mail/valor). */
export function paraRecente(r: SearchResult): SearchResult {
  return { kind: r.kind, id: r.id, title: r.title, path: r.path };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function limparRecentesLegados(): void {
  try { storage()?.removeItem(CHAVE_RECENTES_LEGADA); } catch { /* storage bloqueado: nada a limpar */ }
}

export function lerRecentes(userId: string | null | undefined): SearchResult[] {
  limparRecentesLegados();
  const st = storage();
  if (!st || !userId) return [];
  try {
    const raw = st.getItem(chaveRecentes(userId));
    const lidos = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(lidos)) return [];
    // re-sanitiza o que estiver gravado (versão anterior deste formato ou edição manual)
    return lidos
      .filter((r): r is SearchResult => !!r && typeof r === 'object' && typeof (r as SearchResult).id === 'string'
        && typeof (r as SearchResult).path === 'string' && typeof (r as SearchResult).title === 'string')
      .map(paraRecente)
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

export function gravarRecentes(userId: string | null | undefined, items: SearchResult[]): void {
  const st = storage();
  if (!st || !userId) return;
  const chave = chaveRecentes(userId);
  try {
    st.setItem(chave, JSON.stringify(items.map(paraRecente).slice(0, MAX_RECENTS)));
  } catch { /* cota/privado: recentes são conveniência, não estado */ }
  window.dispatchEvent(new StorageEvent('storage', { key: chave }));
}

export interface ClienteBuscaRow {
  user_id: string;
  name: string | null;
  razao_social: string | null;
  contato_visivel: boolean;
  documento: string | null;
  email: string | null;
}

/** Linha da RPC → resultado do Cmd-K. Subtitle só com o que o SERVIDOR liberou. */
export function mapearClientesBusca(rows: ClienteBuscaRow[]): SearchResult[] {
  return rows.map((p) => ({
    kind: 'customer',
    id: p.user_id,
    title: p.name ?? p.razao_social ?? 'Sem nome',
    subtitle: p.contato_visivel ? (p.documento ?? p.email ?? undefined) : undefined,
    // Vai direto pro 360° (dashboard rico), não pra lista com modal genérico
    path: `/admin/customers/${p.user_id}/360`,
  }));
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
      // Termo só-wildcard (`**`, passa o length>=2) → busca vazia (#1062); o servidor também neutraliza.
      if (!isSearchablePostgrestTerm(trimmed)) return [];
      // Escopo, exclusão de staff e máscara de documento/e-mail são do SERVIDOR (onda D): ler
      // `profiles` direto aqui buscava CPF/e-mail de qualquer um e listava funcionário como cliente.
      const { data, error } = await supabase.rpc('buscar_clientes_global', { p_termo: trimmed, p_limite: 5 });
      if (error) throw error; // supabase-js não lança: sem isto a falha virava "Nada encontrado"
      return mapearClientesBusca((data ?? []) as ClienteBuscaRow[]);
    },
  });

  /* ─── Tint formulas ─── */
  const formulasQuery = useQuery<SearchResult[]>({
    queryKey: ['gs-formulas', trimmed],
    enabled: isActive,
    staleTime: 60_000,
    queryFn: async () => {
      if (!isSearchablePostgrestTerm(trimmed)) return []; // só-wildcard → match-all (#1062); busca vazia
      const { data, error } = await supabase
        .from('tint_formulas')
        .select('id, cor_id, nome_cor')
        .is('desativada_em', null)
        .or(ilikeOr(['cor_id', 'nome_cor'], trimmed))
        .limit(5);
      if (error) throw error;
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
      // .ilike() único: o helper strippa os curingas do ILIKE (% _ *). O null (termo degenerado)
      // não chega aqui, porque a query só roda com termo só-dígitos; se chegasse, busca vazia.
      const pat = ilikeContainsPattern(trimmed);
      if (!pat) return [];
      const { data, error } = await supabase
        .from('sales_orders')
        .select('id, omie_numero_pedido, total, customer_user_id')
        .ilike('omie_numero_pedido', pat)
        .limit(5);
      if (error) throw error;
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

  // Falha de uma categoria FALA (não vira "Nada encontrado"); as outras seguem.
  const erros = useMemo(() => {
    const out: string[] = [];
    if (customersQuery.isError) out.push('clientes');
    if (formulasQuery.isError) out.push('fórmulas');
    if (ordersQuery.isError) out.push('pedidos');
    return out;
  }, [customersQuery.isError, formulasQuery.isError, ordersQuery.isError]);

  return {
    isActive,
    isLoading,
    groups,
    erros,
    hasResults: groups.length > 0,
  };
}

/** Hook standalone pra ler/atualizar recentes (consumido pela palette). Recentes são POR USUÁRIO. */
export function useSearchRecents() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [recents, setRecents] = useState<SearchResult[]>(() => lerRecentes(userId));

  useEffect(() => {
    setRecents(lerRecentes(userId));
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || (userId && e.key === chaveRecentes(userId))) setRecents(lerRecentes(userId));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [userId]);

  const push = (result: SearchResult) => {
    setRecents((prev) => {
      // Move to top, dedupe por path
      const next = [paraRecente(result), ...prev.filter((r) => r.path !== result.path)].slice(0, MAX_RECENTS);
      gravarRecentes(userId, next);
      return next;
    });
  };

  const clear = () => {
    gravarRecentes(userId, []);
    setRecents([]);
  };

  return { recents, push, clear };
}
