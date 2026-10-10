// Escopo de LEITURA da lista de clientes (lente-aware), SEM mutação.
// Isolado de useAdminCustomers de propósito: o guard display-access-no-write proíbe
// useDisplayAccess no mesmo arquivo que faz escrita (.insert/.update/.upsert/.delete).
// Aqui só há leitura — useAdminCustomers consome este scope e detém as mutações.
// Spec: docs/superpowers/specs/2026-06-11-clientes-escopo-carteira-design.md
import { useMemo } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import { ilikeOr, isSearchablePostgrestTerm } from '@/lib/postgrest';
import {
  resolveModoEscopo, fetchCarteiraClientes, fetchScoresPorCustomer, hashIds,
} from '@/lib/carteira/escopo-clientes';
import type { Customer, ClientScore } from './types';

const PAGE_SIZE = 100;
const COLUNAS_PROFILE = 'user_id, name, email, phone, document, customer_type, created_at, requires_po';
/** Colunas da busca no servidor — o filtro local da carteira usa as MESMAS (CustomerListView). */
const COLUNAS_BUSCA = ['name', 'email', 'document', 'phone'];

/**
 * Resolução do deep link `/admin/customers/:customerId`, independente das páginas carregadas.
 * - `encontrado`: o cliente está visível no escopo (na lista OU lido por id na base completa).
 * - `fora_do_escopo`: modo carteira, carteira lida inteira e o id não está nela.
 * - `nao_encontrado`: base completa, leitura por id voltou vazia (não existe, é funcionário ou a RLS não mostra).
 * - `erro`: a leitura falhou — não dá pra afirmar que o cliente não existe.
 */
export type ClienteAlvo =
  | { estado: 'nenhum' }
  | { estado: 'carregando' }
  | { estado: 'encontrado'; customer: Customer }
  | { estado: 'fora_do_escopo' }
  | { estado: 'nao_encontrado' }
  | { estado: 'erro'; refetch: () => void };

export interface ClientesScope {
  customers: Customer[];
  scores: Map<string, ClientScore>;
  total: number;
  isCarteira: boolean;
  loading: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  /**
   * Falha da fonte da LISTA (carteira ou base). Sem isto, `data === undefined` virava
   * `customers = []` e a tela dizia "Nenhum cliente" — falha de leitura apresentada como
   * base vazia (§7: ausente ≠ vazio). Com dado em cache o react-query preserva `customers`
   * através do refetch falho — a tela decide entre "indisponível" (sem dado) e "stale".
   */
  isError: boolean;
  /** Retry da fonte da lista — o "Tentar novamente" do estado de erro. */
  refetch: () => void;
  /** id efetivo (alvo na lente, próprio fora dela) — consumido pelo orquestrador p/ reset de detalhe. */
  effectiveUserId: string | null;
  /**
   * `true` quando o termo de busca foi aplicado NO SERVIDOR (modo completa): `customers` já é o
   * resultado da busca, e a tela não deve re-filtrar em memória. Na carteira (lida inteira) a
   * busca segue local — a lista em memória É o universo, e nenhuma query nova alarga o escopo.
   */
  buscaNoServidor: boolean;
  /** A lista à vista é o resultado do termo ANTERIOR enquanto o novo é buscado. */
  buscando: boolean;
  clienteAlvo: ClienteAlvo;
}

export function useClientesScope({ busca = '', customerIdAlvo = null }: {
  /** Termo da URL (`?search=`), já debounced pela lista. */
  busca?: string;
  /** `:customerId` do deep link. */
  customerIdAlvo?: string | null;
} = {}): ClientesScope {
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
  // Com termo de busca, a busca vai ao SERVIDOR: filtrar em memória só enxergava as páginas já
  // carregadas (incidente 2026-10-09: "HELIOMAR" → "Nenhum cliente" com o cliente existindo).
  const termo = busca.trim();
  const buscaNoServidor = !isCarteira && isSearchablePostgrestTerm(termo);
  const termoServidor = buscaNoServidor ? termo : '';
  const baseQuery = useInfiniteQuery({
    queryKey: ['admin-clientes-base', termoServidor],
    enabled: queriesReady && !isCarteira,
    // Trocar o termo troca a key: sem isto `isLoading` volta a true e a página inteira vira
    // skeleton — desmontando o input no meio da digitação. Mantém o resultado anterior à vista
    // (sinalizado por `buscando`) até o novo chegar.
    placeholderData: keepPreviousData,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const start = (pageParam as number) * PAGE_SIZE;
      let q = supabase
        .from('profiles')
        .select(COLUNAS_PROFILE)
        .eq('is_employee', false);
      if (termoServidor) q = q.or(ilikeOr(COLUNAS_BUSCA, termoServidor));
      // Ordem TOTAL (name não é único): sem o desempate por user_id o `.range` pode repetir ou
      // pular homônimos na fronteira entre páginas.
      const { data, error } = await q
        .order('name')
        .order('user_id')
        .range(start, start + PAGE_SIZE - 1);
      if (error) throw error;
      // data null SEM error = malformada, não página vazia (classe #1338→#1564): o `|| []`
      // encerraria o infinite scroll como se a base tivesse acabado.
      if (data == null) throw new Error('profiles (base completa): data null sem error — malformada, não é fim');
      return data as Customer[];
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

  /* ─── DEEP LINK: cliente por id, sem depender das páginas carregadas ─── */
  const alvoNaLista = useMemo(
    () => (customerIdAlvo ? customers.find((c) => c.user_id === customerIdAlvo) ?? null : null),
    [customerIdAlvo, customers],
  );
  // Só no modo completa: lá o escopo É a base inteira (mesmo filtro is_employee=false + RLS).
  // Na carteira NÃO se lê por id — na lente a sessão é a do master (RLS vê tudo) e a leitura
  // direta vazaria cliente fora da carteira do alvo. Lá a carteira inteira já está em memória.
  const alvoQuery = useQuery({
    queryKey: ['admin-cliente-alvo', customerIdAlvo],
    enabled: queriesReady && !isCarteira && !!customerIdAlvo && !alvoNaLista,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select(COLUNAS_PROFILE)
        .eq('user_id', customerIdAlvo as string)
        .eq('is_employee', false)
        .maybeSingle();
      if (error) throw error;
      // maybeSingle: null sem error = nenhuma linha visível — é "não encontrado", não malformado.
      return (data ?? null) as Customer | null;
    },
  });

  const clienteAlvo = useMemo<ClienteAlvo>(() => {
    if (!customerIdAlvo) return { estado: 'nenhum' };
    if (alvoNaLista) return { estado: 'encontrado', customer: alvoNaLista };
    if (!queriesReady) return { estado: 'carregando' };
    if (isCarteira) {
      if (carteiraQuery.isPending) return { estado: 'carregando' };
      if (carteiraQuery.isError) return { estado: 'erro', refetch: () => { carteiraQuery.refetch(); } };
      return { estado: 'fora_do_escopo' };
    }
    if (alvoQuery.isPending) return { estado: 'carregando' };
    if (alvoQuery.isError) return { estado: 'erro', refetch: () => { alvoQuery.refetch(); } };
    if (alvoQuery.data) return { estado: 'encontrado', customer: alvoQuery.data };
    // A leitura por id corre em paralelo com a 1ª página: só afirma ausência depois que a lista
    // também respondeu (senão "não encontrado" pisca antes da lista achar o cliente).
    return baseQuery.isPending ? { estado: 'carregando' } : { estado: 'nao_encontrado' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    customerIdAlvo, alvoNaLista, queriesReady, isCarteira,
    carteiraQuery.isPending, carteiraQuery.isError, alvoQuery.isPending, alvoQuery.isError, alvoQuery.data,
    baseQuery.isPending,
  ]);

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
  // Score do cliente do deep link que não está na lista: consulta própria (1 id), para não
  // re-buscar os scores da lista inteira só por causa dele.
  const alvoForaDaLista = clienteAlvo.estado === 'encontrado' && !alvoNaLista ? clienteAlvo.customer.user_id : null;
  const alvoScoreQuery = useQuery({
    queryKey: ['admin-clientes-scores-alvo', alvoForaDaLista],
    enabled: queriesReady && !!alvoForaDaLista,
    staleTime: 60_000,
    queryFn: () => fetchScoresPorCustomer([alvoForaDaLista as string]),
  });
  const scores = useMemo(() => {
    const base = scoresQuery.data ?? new Map<string, ClientScore>();
    if (!alvoScoreQuery.data?.size) return base;
    return new Map([...base, ...alvoScoreQuery.data]);
  }, [scoresQuery.data, alvoScoreQuery.data]);

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
    isError: isCarteira ? carteiraQuery.isError : baseQuery.isError,
    refetch: () => { if (isCarteira) carteiraQuery.refetch(); else baseQuery.refetch(); },
    effectiveUserId,
    buscaNoServidor,
    buscando: !isCarteira && baseQuery.isPlaceholderData,
    clienteAlvo,
  };
}
