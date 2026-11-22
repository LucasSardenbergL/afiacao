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
import { isSearchablePostgrestTerm } from '@/lib/postgrest';
import {
  resolveModoEscopo, fetchCarteiraClientes, fetchScoresPorCustomer, hashIds, ordenarCarteira,
} from '@/lib/carteira/escopo-clientes';
import {
  TAMANHO_PAGINA_CLIENTES, normalizarFiltroSaude, normalizarOrdem, type EstadoScores, type FiltroSaude, type OrdemClientes,
} from './config';
import type { Customer, ClientScore } from './types';

const PAGE_SIZE = TAMANHO_PAGINA_CLIENTES;
const COLUNAS_PROFILE = 'user_id, name, email, phone, document, customer_type, created_at, requires_po';

/**
 * Resolução do deep link `/admin/customers/:customerId`, independente das páginas carregadas.
 * - `encontrado`: o cliente está visível no escopo (na lista OU lido por id na base completa).
 * - `fora_do_escopo`: modo carteira, carteira lida inteira e o id não está nela.
 * - `nao_encontrado`: base completa, leitura por id voltou vazia (não existe, é funcionário ou a RLS não mostra).
 * - `erro`: a leitura falhou — não dá pra afirmar que o cliente não existe.
 */
type ClienteAlvo =
  | { estado: 'nenhum' }
  | { estado: 'carregando' }
  | { estado: 'encontrado'; customer: Customer }
  | { estado: 'fora_do_escopo' }
  | { estado: 'nao_encontrado' }
  | { estado: 'erro'; refetch: () => void };

export interface ClientesScope {
  customers: Customer[];
  scores: Map<string, ClientScore>;
  /** Total CONFIRMADO pela fonte; `null` = pendente ou indisponível (nunca vira 0). */
  total: number | null;
  /** A contagem ainda está sendo buscada. */
  contagemPendente: boolean;
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
  /**
   * `true` no modo completa: filtro de saúde e ordem já vêm aplicados pelo SERVIDOR, antes da
   * paginação (RPC `listar_clientes_base`) — a tela não re-filtra nem re-ordena em memória.
   */
  filtroNoServidor: boolean;
  /**
   * Tamanho do recorte (busca + saúde) no servidor, antes de paginar. `null` = carteira (a lista
   * em memória é o recorte) ou 1ª página ainda não chegou — nunca "0" fabricado.
   */
  totalRecorte: number | null;
  clienteAlvo: ClienteAlvo;
  /**
   * Estado da leitura dos SCORES da lista. Sem isto o mapa vazio de quem ainda carrega (ou falhou)
   * fazia o filtro local de saúde da carteira dizer "nenhum cliente" e a prioridade sumir — falha
   * apresentada como resultado. Com dado em cache e refetch falho, segue 'ok' (o dado é o último lido).
   */
  scoresEstado: EstadoScores;
  /** Retry só dos scores (o "Tentar novamente" do aviso do filtro de saúde). */
  refetchScores: () => void;
}

export function useClientesScope({ busca = '', saude = null, ordem = 'prioridade', customerIdAlvo = null }: {
  /** Termo da URL (`?search=`), já debounced pela lista. */
  busca?: string;
  /** Filtro de saúde da URL (`?health=`); `null`/desconhecido = todos. */
  saude?: string | null;
  /** Ordem da URL (`?ordem=`); padrão "Priorizar contatos". */
  ordem?: string | null;
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

  /* ─── MODO COMPLETA: base inteira paginada NO SERVIDOR + count exato ─── */
  // Busca, filtro de saúde e ordem vão ao SERVIDOR, antes da paginação (RPC listar_clientes_base,
  // SECURITY INVOKER — mesma RLS da leitura direta de profiles/farmer_client_scores). Filtrar ou
  // ordenar em memória só enxergaria as páginas já carregadas (incidente 2026-10-09: "HELIOMAR" →
  // "Nenhum cliente"; e "Crítico" → "nenhum nas páginas carregadas"). O teto é o EIXO: a ordem
  // por prioridade tem de nascer onde o score mora, não nos 100 primeiros por nome.
  const termo = busca.trim();
  const buscaNoServidor = !isCarteira && isSearchablePostgrestTerm(termo);
  const termoServidor = buscaNoServidor ? termo : '';
  const saudeServidor: FiltroSaude | null = isCarteira ? null : normalizarFiltroSaude(saude);
  const ordemServidor: OrdemClientes = normalizarOrdem(ordem);
  const baseQuery = useInfiniteQuery({
    queryKey: ['admin-clientes-base', termoServidor, saudeServidor, ordemServidor],
    enabled: queriesReady && !isCarteira,
    // Trocar termo/filtro/ordem troca a key: sem isto `isLoading` volta a true e a página inteira
    // vira skeleton — desmontando o input no meio da digitação. Mantém o resultado anterior à
    // vista (sinalizado por `buscando`) até o novo chegar.
    placeholderData: keepPreviousData,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      // A ordem TOTAL (prioridade → nome_ordenacao → name → user_id) e o LIMIT/OFFSET moram na RPC: o `.range`
      // não repete nem pula homônimos na fronteira entre páginas. PAGE_SIZE < teto de 1.000.
      const args = {
        p_busca: termoServidor || undefined,
        p_saude: saudeServidor ?? undefined,
        p_ordem: ordemServidor,
        p_limite: PAGE_SIZE,
        p_offset: (pageParam as number) * PAGE_SIZE,
      };
      const { data, error } = await supabase.rpc('listar_clientes_base', args)
        // A RPC já ordena e pagina (LIMIT/OFFSET). O `.order` repete as MESMAS chaves (mesmo eixo,
        // mesma collation; prioridade_ordenacao vem NULL na ordem 'nome') — não muda a sequência,
        // só a declara estável; o `.range` é o cinto do teto de 1.000. Gates G7 + rpc-set-returning.
        // nome_ordenacao = o nome do Omie normalizado (private.nome_ordenacao, migration
        // 20261121132032): sem prefixo MEI/entidade HTML/símbolo — o A–Z não abre com lixo.
        .order('prioridade_ordenacao', { ascending: false, nullsFirst: false })
        .order('nome_ordenacao', { ascending: true, nullsFirst: false })
        .order('name')
        .order('user_id')
        .range(0, PAGE_SIZE - 1);
      if (error) throw error;
      // data null SEM error = malformada, não página vazia (classe #1338→#1564): o `|| []`
      // encerraria o infinite scroll como se a base tivesse acabado.
      if (data == null) throw new Error('listar_clientes_base: data null sem error — malformada, não é fim');
      const linhas = data as Array<Customer & { prioridade_ordenacao: number | null; total: number | string }>;
      // `total` vem repetido em toda linha (count do recorte antes de paginar); página vazia = 0.
      const totalRecorte = linhas.length > 0 ? Number(linhas[0].total) : (pageParam === 0 ? 0 : null);
      const customers = linhas.map(({ prioridade_ordenacao: _p, total: _t, ...c }) => c as Customer);
      return { customers, totalRecorte };
    },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.customers.length === PAGE_SIZE ? allPages.length : undefined,
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
      // `count: null` sem error = contagem não informada — NÃO é base vazia (ausente ≠ zero).
      return count ?? null;
    },
  });

  const customers = useMemo<Customer[]>(() => {
    if (isCarteira) return carteiraQuery.data?.customers ?? [];
    return baseQuery.data?.pages.flatMap((p) => p.customers) ?? [];
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
  const scoresEstado: EstadoScores = visibleIds.length === 0 || scoresQuery.data
    ? 'ok'
    : scoresQuery.isError ? 'falha' : 'carregando';
  const scores = useMemo(() => {
    const base = scoresQuery.data ?? new Map<string, ClientScore>();
    if (!alvoScoreQuery.data?.size) return base;
    return new Map([...base, ...alvoScoreQuery.data]);
  }, [scoresQuery.data, alvoScoreQuery.data]);

  // Carteira (lida inteira): a ordem escolhida é aplicada AQUI, com os scores — espelho da ordem do
  // servidor na base completa. Os ids/hash dos scores usam a lista crua (A–Z), não esta: reordenar
  // não pode trocar a key e re-buscar os scores. Sem scores (carregando/falha) cai no A–Z.
  const customersNaOrdem = useMemo<Customer[]>(
    () => (isCarteira ? ordenarCarteira(customers, scores, ordemServidor) : customers),
    [isCarteira, customers, scores, ordemServidor],
  );

  // Total só CONFIRMADO: carteira = inteira em memória após sucesso; base = count do servidor.
  // `null` + `contagemPendente` → a tela diz "N carregados"; `null` sem pendência → indisponível.
  const total: number | null = isCarteira
    ? (carteiraQuery.isSuccess ? customers.length : null)
    : (baseCountQuery.data ?? null);
  const contagemPendente = isCarteira ? carteiraQuery.isPending : baseCountQuery.isPending;
  const totalRecorte = isCarteira ? null : (baseQuery.data?.pages[0]?.totalRecorte ?? null);
  const loading = isCarteira ? carteiraQuery.isLoading : baseQuery.isLoading;

  return {
    customers: customersNaOrdem,
    scores,
    total,
    contagemPendente,
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
    filtroNoServidor: !isCarteira,
    totalRecorte,
    clienteAlvo,
    scoresEstado,
    refetchScores: () => { scoresQuery.refetch(); },
  };
}
