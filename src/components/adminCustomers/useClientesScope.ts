// Escopo de LEITURA da lista de clientes (lente-aware), SEM mutação.
// Isolado de useAdminCustomers de propósito: o guard display-access-no-write proíbe
// useDisplayAccess no mesmo arquivo que faz escrita (.insert/.update/.upsert/.delete).
// Aqui só há leitura — useAdminCustomers consome este scope e detém as mutações.
// Spec: docs/superpowers/specs/2026-06-11-clientes-escopo-carteira-design.md
import { useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import {
  resolveModoEscopo, fetchCarteiraClientes, fetchScoresPorCustomer, hashIds,
} from '@/lib/carteira/escopo-clientes';
import type { Customer, ClientScore } from './types';

const PAGE_SIZE = 100;

export interface ClientesScope {
  customers: Customer[];
  scores: Map<string, ClientScore>;
  total: number;
  isCarteira: boolean;
  loading: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  /** id efetivo (alvo na lente, próprio fora dela) — consumido pelo orquestrador p/ reset de detalhe. */
  effectiveUserId: string | null;
}

export function useClientesScope(): ClientesScope {
  const { user, isStaff } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const { displayIsMaster, displayIsGestorComercial, displayIsSalesOnly, displayLoading } = useDisplayAccess();

  const modo = resolveModoEscopo({ displayIsMaster, displayIsGestorComercial, displayIsSalesOnly });
  const isCarteira = modo === 'carteira';
  const baseId = isImpersonating ? effectiveUserId : (user?.id ?? null);
  const queriesReady = isStaff && !displayLoading && !!user;

  /* ─── MODO CARTEIRA: carteira inteira de uma vez ─── */
  const carteiraQuery = useQuery({
    queryKey: ['admin-clientes-carteira', baseId, isImpersonating],
    enabled: queriesReady && isCarteira && !!baseId,
    staleTime: 60_000,
    queryFn: () => fetchCarteiraClientes({ isImpersonating, effectiveUserId, baseId }),
  });

  /* ─── MODO COMPLETA: base inteira paginada + count exato ─── */
  const baseQuery = useInfiniteQuery({
    queryKey: ['admin-clientes-base'],
    enabled: queriesReady && !isCarteira,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const start = (pageParam as number) * PAGE_SIZE;
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name, email, phone, document, customer_type, created_at, requires_po')
        .eq('is_employee', false)
        .order('name')
        .range(start, start + PAGE_SIZE - 1);
      if (error) throw error;
      return (data || []) as Customer[];
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === PAGE_SIZE ? allPages.length : undefined,
  });

  const baseCountQuery = useQuery({
    queryKey: ['admin-clientes-base-count'],
    enabled: queriesReady && !isCarteira,
    staleTime: 60_000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('profiles')
        .select('user_id', { count: 'exact', head: true })
        .eq('is_employee', false);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const customers = useMemo<Customer[]>(() => {
    if (isCarteira) return carteiraQuery.data?.customers ?? [];
    return baseQuery.data?.pages.flat() ?? [];
  }, [isCarteira, carteiraQuery.data, baseQuery.data]);

  const visibleIds = useMemo(() => customers.map((c) => c.user_id), [customers]);
  // Hash estável dos IDs (não só a contagem) p/ a key dos scores não reusar o map de um
  // conjunto anterior de mesmo tamanho (reatribuição que mantém a length). Codex P2.
  const idsHash = useMemo(() => hashIds(visibleIds), [visibleIds]);

  /* ─── SCORES por customer_user_id (ambos os modos) ─── */
  const scoresQuery = useQuery({
    queryKey: ['admin-clientes-scores', isCarteira ? 'carteira' : 'completa', baseId, idsHash],
    enabled: queriesReady && visibleIds.length > 0,
    staleTime: 60_000,
    queryFn: () => fetchScoresPorCustomer(visibleIds),
  });
  const scores = useMemo(
    () => scoresQuery.data ?? new Map<string, ClientScore>(),
    [scoresQuery.data],
  );

  const total = isCarteira ? customers.length : (baseCountQuery.data ?? customers.length);
  const loading = isCarteira ? carteiraQuery.isLoading : baseQuery.isLoading;

  return {
    customers,
    scores,
    total,
    isCarteira,
    loading,
    hasNextPage: isCarteira ? false : !!baseQuery.hasNextPage,
    isFetchingNextPage: isCarteira ? false : baseQuery.isFetchingNextPage,
    fetchNextPage: () => { if (!isCarteira) baseQuery.fetchNextPage(); },
    effectiveUserId,
  };
}
