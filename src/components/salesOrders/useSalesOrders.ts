// Lógica da listagem de pedidos de venda — sobre a view order_feed (read model único).
//
// A view tem ~32 k pedidos. A listagem abre com uma página de FEED_PAGE_SIZE (ordem estável:
// created_at desc, origin, id) e carrega mais ao rolar; aba de empresa e busca vão como filtro
// pro servidor, então a busca alcança TODOS os pedidos. Antes a tela drenava 5 × 1.000 linhas a
// cada abertura (1,19 MB) e filtrava em JS — a busca não achava pedido fora desse recorte
// (plano v4, lote 8 — C3). A busca compara com a coluna `busca` da view (migration 20261101221452).
// Spec original da view: docs/superpowers/specs/2026-06-06-order-feed-view-unificada-design.md
import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useUrlState } from '@/hooks/useUrlState';
import { toast } from 'sonner';
import { shareOrderViaWhatsApp } from '@/utils/whatsappShare';
import { formatarDataPedido } from '@/lib/pedido/data-pedido';
import {
  type Account,
  type OrderFeedRow,
  type PaginaFeed,
} from './types';
import {
  COLUNAS_LISTAGEM_FEED, dedupeFeedRows, ehFiltroStatus, ehOrdem, ehPeriodo, feedRowDaLinha, filtroDoPeriodo,
  padraoBuscaFeed, STATUS_DO_FILTRO, type FiltroStatusFeed, type OrdemFeed, type PeriodoFeed,
} from './feed';
import { track } from '@/lib/analytics';
import { fetchOrderDetail, orderDetailQueryKey } from './useSalesOrderDetail';
import { descontosItensQueryKey } from './useDescontosItensPedido';
import { softDeleteOrder } from './soft-delete';
import { printSalesOrder } from './print';
import { montarCompartilhamento } from './compartilhar';
import { buscarDescontosItens } from '@/components/sales/print/buscarDescontosItens';
import { leituraDoPedido, mensagemAvisoDesconto, type LeituraDescontosItens } from '@/components/sales/print/descontoCupom';
import { ehFalhaDePagina } from '@/lib/postgrest';
import { mensagemDoErroEdge } from '@/lib/invoke-function';
import { mensagemDeErro } from '@/lib/erro-mensagem';

export const FEED_PAGE_SIZE = 50;

const EMPRESAS: readonly Account[] = ['all', 'oben', 'colacor', 'colacor_sc'];
const ehEmpresa = (v: string): v is Account => (EMPRESAS as readonly string[]).includes(v);

const FILTROS_PADRAO = { q: '', empresa: 'all', status: 'todos', periodo: 'tudo', ordem: 'recentes', customer: '' };

/** `?customer=` válido (uuid do `customer_user_id`) ou `null`. Valor torto cai no padrão (todos). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function clienteDoFiltro(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return UUID.test(t) ? t.toLowerCase() : null;
}

export function useSalesOrders() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, isStaff, loading: authLoading, role } = useAuth();
  // Filtros na URL (compartilháveis, sobrevivem ao F5). `q` chega aqui já com debounce: quem segura
  // a digitação é a toolbar, para cada tecla não re-renderizar a lista inteira.
  const [filtros, setFiltros] = useUrlState(FILTROS_PADRAO);
  const search = filtros.q;
  // Valor desconhecido na URL (link velho, digitado à mão) cai no padrão — nunca num filtro torto.
  const accountFilter: Account = ehEmpresa(filtros.empresa) ? filtros.empresa : 'all';
  const statusFilter: FiltroStatusFeed = ehFiltroStatus(filtros.status) ? filtros.status : 'todos';
  const periodo: PeriodoFeed = ehPeriodo(filtros.periodo) ? filtros.periodo : 'tudo';
  const ordem: OrdemFeed = ehOrdem(filtros.ordem) ? filtros.ordem : 'recentes';
  // Pedidos de UM cliente (a ficha manda `/sales?customer=<id>`): antes o parâmetro era ignorado e o
  // "Ver todos" do cliente abria todos os pedidos da empresa.
  const clienteFiltro = clienteDoFiltro(filtros.customer);
  const limparCliente = () => setFiltros({ customer: '' });
  const setSearch = (q: string) => setFiltros({ q });
  const setAccountFilter = (empresa: Account) => {
    track('sales.lista_filtro', { tipo: 'empresa', valor: empresa });
    setFiltros({ empresa });
  };
  const setStatusFilter = (status: FiltroStatusFeed) => {
    track('sales.lista_filtro', { tipo: 'status', valor: status });
    setFiltros({ status });
  };
  const setPeriodo = (p: PeriodoFeed) => {
    track('sales.lista_filtro', { tipo: 'periodo', valor: p });
    setFiltros({ periodo: p });
  };
  const setOrdem = (o: OrdemFeed) => {
    track('sales.lista_filtro', { tipo: 'ordem', valor: o });
    setFiltros({ ordem: o });
  };
  // Uma escrita só: TODAS as chaves voltam ao padrão juntas na URL.
  const limparFiltros = () => setFiltros(FILTROS_PADRAO);
  const comFiltro = !!search.trim() || accountFilter !== 'all' || statusFilter !== 'todos' || periodo !== 'tudo' || !!clienteFiltro;
  // Seleção guarda a LINHA, não só o id: trocar a busca tira o pedido da tela, e o bulk delete ainda
  // precisa dele (omie_pedido_id, origin).
  const [selecionados, setSelecionados] = useState<Map<string, OrderFeedRow>>(new Map());
  const selectedIds = useMemo(() => new Set(selecionados.keys()), [selecionados]);

  useEffect(() => {
    if (!authLoading && role !== null && !isStaff) navigate('/', { replace: true });
  }, [authLoading, role, isStaff, navigate]);

  /* ─── Feed paginado no servidor ─── */
  // userId na key: troca de sessão não serve cache do usuário anterior. O prefixo (sem filtros) é o
  // que o optimistic e a reconciliação do delete varrem.
  const feedKeyBase = useMemo(() => ['order-feed', user?.id] as const, [user?.id]);
  const padrao = padraoBuscaFeed(search);
  // O corte do período entra na key já calculado: virar o dia muda o corte e a key (sem cache velho).
  const cortePeriodo = filtroDoPeriodo(periodo);
  const feedQuery = useInfiniteQuery({
    queryKey: [...feedKeyBase, accountFilter, padrao, statusFilter, cortePeriodo, ordem, clienteFiltro],
    enabled: isStaff && !!user,
    staleTime: 60_000,
    // Trocar a busca mantém a lista anterior na tela até a nova chegar (sem piscar o skeleton).
    placeholderData: keepPreviousData,
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<PaginaFeed> => {
      // count só na 1ª página e só sem busca: com busca ele seria um 2º scan dos ~32 k na mesma query.
      let query = supabase
        .from('order_feed')
        .select(COLUNAS_LISTAGEM_FEED, { count: pageParam === 0 && !padrao ? 'exact' : undefined });
      if (accountFilter !== 'all') query = query.eq('account', accountFilter);
      if (clienteFiltro) query = query.eq('customer_user_id', clienteFiltro);
      if (padrao) query = query.ilike('busca', padrao);
      if (statusFilter === 'rascunhos') query = query.eq('status', 'rascunho');
      else if (statusFilter !== 'todos') query = query.in('status', [...STATUS_DO_FILTRO[statusFilter]]);
      if (cortePeriodo) query = query.or(cortePeriodo);
      // "Maior valor": total ausente (null) vai pro FIM — nunca é lido como zero nem sobe na frente.
      if (ordem === 'valor') query = query.order('total', { ascending: false, nullsFirst: false });
      const { data, error, count } = await query
        .order('created_at', { ascending: false })
        .order('origin', { ascending: true })
        .order('id', { ascending: true })
        .range(pageParam, pageParam + FEED_PAGE_SIZE - 1);
      if (error) throw error;
      return { rows: (data ?? []).map(feedRowDaLinha), count: count ?? null, offset: pageParam };
    },
    // Página parcial = acabou. Offset com ordem estável; um pedido novo entre duas páginas desloca
    // uma linha, e o dedupe abaixo tira a duplicata.
    getNextPageParam: (ultima) => (ultima.rows.length < FEED_PAGE_SIZE ? undefined : ultima.offset + FEED_PAGE_SIZE),
  });

  const orders = useMemo(
    () => dedupeFeedRows(feedQuery.data?.pages.flatMap((p) => p.rows) ?? []),
    [feedQuery.data],
  );
  // Total do servidor para a aba atual (null com busca — ver queryFn).
  const totalCount = feedQuery.data?.pages[0]?.count ?? null;
  // Filtro/aba nova a caminho com as linhas da anterior na tela (keepPreviousData): elas NÃO são do
  // filtro atual, então seleção e ações ficam suspensas até a resposta chegar (Codex, 2ª rodada).
  const emTransicao = feedQuery.isPlaceholderData;

  // Medição da busca: só se ela achou algo — o TERMO nunca sai daqui. 1 evento por termo assentado.
  const buscaMedida = useRef<string | null>(null);
  const buscaAssentada = !!padrao && feedQuery.isSuccess && !emTransicao;
  useEffect(() => {
    if (!buscaAssentada || buscaMedida.current === padrao) return;
    buscaMedida.current = padrao;
    track('sales.lista_busca', { tem_resultado: orders.length > 0 });
  }, [buscaAssentada, padrao, orders.length]);

  /* ─── Logos das empresas (cupom de impressão) — cache 24h ─── */
  const logosQuery = useQuery({
    queryKey: ['sales-orders-company-logos'],
    enabled: isStaff,
    staleTime: 1000 * 60 * 60 * 24,
    queryFn: async () => {
      try {
        const { data } = await supabase.functions.invoke('omie-cliente', {
          body: { action: 'buscar_logos_empresas' },
        });
        return (data?.logos || {}) as Record<string, string | null>;
      } catch {
        return {};
      }
    },
  });
  const companyLogos = logosQuery.data || {};

  /* ─── Detalhe sob demanda (cache compartilhado com o painel via queryKey) ─── */
  const getDetail = (row: Pick<OrderFeedRow, 'origin' | 'id'> & { customer_name?: string | null }) =>
    queryClient.fetchQuery({
      queryKey: orderDetailQueryKey(user?.id, row.origin, row.id),
      queryFn: () => fetchOrderDetail(row.origin, row.id, row.customer_name),
      staleTime: 60_000,
    });

  /* ─── Desconto dos itens (order_items.desconto_valor) — o cupom, a mensagem de WhatsApp e o painel de detalhe ─── */
  // Mesma chave do painel (`descontosItensQueryKey`): o hover da listagem aquece o cupom, a mensagem e o painel.
  // Falha de LEITURA (página assinada pelo fetchAllPages) vira `falhou` — o cupom e a mensagem saem
  // como hoje e a tela avisa; qualquer outra exceção é bug e sobe crua, sem se disfarçar de "indisponível".
  const getDescontosItens = async (row: Pick<OrderFeedRow, 'origin' | 'id'>): Promise<LeituraDescontosItens> => {
    if (row.origin !== 'sales') return { estado: 'nao-se-aplica' };
    try {
      const porPedido = await queryClient.fetchQuery({
        queryKey: descontosItensQueryKey(user?.id, row.id),
        queryFn: () => buscarDescontosItens([row.id]),
        staleTime: 60_000,
      });
      return leituraDoPedido(porPedido, row.id);
    } catch (e) {
      if (!ehFalhaDePagina(e)) throw e;
      console.warn('[useSalesOrders] desconto dos itens indisponível (cupom e mensagem sem a quebra de desconto):', e);
      return { estado: 'falhou' };
    }
  };

  // Aquece o cache do detalhe (e do desconto dos itens) no hover (catch silencioso — é só
  // otimização). Também mitiga o popup-blocker: com cache quente, o window.open da impressão
  // e do WhatsApp roda imediato no clique (dentro da user activation).
  const prefetchDetail = (row: OrderFeedRow) => {
    void getDetail(row).catch(() => {});
    void getDescontosItens(row).catch(() => {});
  };

  // Imprime o cupom (mesmo layout de /sales/print). Espera o detalhe completo
  // (itens com codigo/unidade/tint, payload de parcelas, endereço) e o desconto
  // dos itens ANTES de abrir.
  const printOrder = async (row: OrderFeedRow) => {
    try {
      const [d, descontos] = await Promise.all([getDetail(row), getDescontosItens(row)]);
      const aviso = mensagemAvisoDesconto([
        printSalesOrder(d.order, d.customerName, d.customerDocument, companyLogos, descontos),
      ]);
      // Aviso da EQUIPE, não do papel: o cupom saiu sem a quebra de um desconto que existe
      // ou que não se conseguiu ler.
      if (aviso) toast.warning(aviso.titulo, { description: aviso.descricao });
    } catch (e) {
      console.error(e);
      toast.error('Não foi possível carregar o pedido para imprimir');
    }
  };

  // Compartilha por WhatsApp. Espera o detalhe e o desconto dos itens ANTES de abrir: quando a régua
  // do cupom confere o desconto, as linhas vão líquidas e a mensagem ganha Subtotal/Desconto
  // (./compartilhar); senão, sai a mensagem de sempre.
  const handleShareOrder = async (row: OrderFeedRow) => {
    try {
      const [d, descontos] = await Promise.all([getDetail(row), getDescontosItens(row)]);
      const { items, quebraDesconto, aviso } = montarCompartilhamento(d.order, descontos);
      const orderNumbers = d.order.omie_numero_pedido
        ? [d.order.omie_numero_pedido.replace(/^0+/, '') || '0']
        : [];
      shareOrderViaWhatsApp({
        customerName: d.customerName,
        items,
        total: d.order.total,
        orderNumbers,
        // String já formatada: pedido do sync (data-pura UTC) sai sem hora
        // fabricada e no dia certo na mensagem ao cliente.
        date: formatarDataPedido(d.order.created_at),
        quebraDesconto,
      });
      // Aviso da EQUIPE, não da mensagem: ela saiu sem as linhas de um desconto que existe ou que
      // não se conseguiu ler.
      if (aviso) toast.warning(aviso.titulo, { description: aviso.descricao });
    } catch (e) {
      console.error(e);
      toast.error('Não foi possível carregar o pedido para compartilhar');
    }
  };

  /* ─── Soft-delete + Omie exclude (optimistic no cache do feed) ─── */
  // Tira as linhas de TODAS as páginas de TODAS as buscas em cache. Não há rollback por snapshot
  // (codex P1: restaurar um snapshot integral ressuscitaria deleções concorrentes que já tinham
  // sucedido): em falha, a reconciliação com o servidor devolve o que de fato continua vivo.
  const tirarDoCache = (ids: Set<string>) => {
    queryClient.setQueriesData<InfiniteData<PaginaFeed>>({ queryKey: feedKeyBase }, (old) => {
      if (!old) return old;
      const removidas = old.pages.reduce(
        (n, p) => n + p.rows.filter((r) => r.origin === 'sales' && ids.has(r.id)).length,
        0,
      );
      return {
        ...old,
        pages: old.pages.map((p) => ({
          ...p,
          rows: p.rows.filter((r) => !(r.origin === 'sales' && ids.has(r.id))),
          count: p.count === null ? null : Math.max(0, p.count - removidas),
        })),
      };
    });
  };
  const reconciliar = () => queryClient.invalidateQueries({ queryKey: feedKeyBase });

  // Trava por pedido, COMPARTILHADA entre a exclusão individual e a em lote, e adquirida antes do
  // 1º await: duas exclusões do MESMO pedido não se sobrepõem (cada uma re-carimbaria deleted_at e
  // o rollback de uma brigaria com o desfecho da outra). O ref é a trava (síncrona); o estado só
  // pinta o "Excluindo…" na UI.
  const travaExclusao = useRef(new Set<string>());
  const [excluindoIds, setExcluindoIds] = useState<ReadonlySet<string>>(() => new Set());
  const travar = (ids: string[]): string[] => {
    const livres = ids.filter((id) => !travaExclusao.current.has(id));
    livres.forEach((id) => travaExclusao.current.add(id));
    if (livres.length > 0) setExcluindoIds(new Set(travaExclusao.current));
    return livres;
  };
  const soltar = (ids: string[]) => {
    ids.forEach((id) => travaExclusao.current.delete(id));
    setExcluindoIds(new Set(travaExclusao.current));
  };

  const deleteOrder = async (row: OrderFeedRow) => {
    if (travar([row.id]).length === 0) return; // já há uma exclusão deste pedido em voo
    try {
      await excluirUm(row);
    } finally {
      soltar([row.id]);
    }
  };

  const excluirUm = async (row: OrderFeedRow) => {
    // Cancela refetch em voo: uma resposta antiga chegando após o optimistic
    // recolocaria o pedido excluído (codex P1).
    await queryClient.cancelQueries({ queryKey: feedKeyBase });
    tirarDoCache(new Set([row.id]));
    setSelecionados((prev) => {
      const next = new Map(prev);
      next.delete(row.id);
      return next;
    });

    const result = await softDeleteOrder({ id: row.id, omie_pedido_id: row.omie_pedido_id });
    // Reconcilia com o servidor nos dois desfechos: no sucesso confirma; na falha devolve o pedido.
    void reconciliar();
    if (result.ok) {
      toast.success('Pedido excluído');
      return;
    }
    toast.error('Erro ao excluir pedido', { description: (result as { message: string }).message });
  };

  // Bulk delete — sequencial pra não floodar o Omie. Mostra progresso.
  const deleteSelected = async () => {
    if (selecionados.size === 0) return;
    const candidatos = [...selecionados.values()].filter((r) => r.origin === 'sales');
    // Pedido com exclusão já em voo fica com ela; o lote só leva os livres (e solta só os seus).
    const livres = new Set(travar(candidatos.map((o) => o.id)));
    const toDelete = candidatos.filter((o) => livres.has(o.id));
    if (toDelete.length === 0) {
      setSelecionados(new Map());
      return;
    }
    try {
      await excluirLote(toDelete);
    } finally {
      soltar([...livres]);
    }
  };

  const excluirLote = async (toDelete: OrderFeedRow[]) => {
    const deleteIds = new Set(toDelete.map((o) => o.id));
    // Cancela refetch em voo (resposta antiga reporia os excluídos — codex P1).
    await queryClient.cancelQueries({ queryKey: feedKeyBase });
    tirarDoCache(deleteIds);
    setSelecionados(new Map());

    // 1. Soft-delete em batch (1 UPDATE com .in('id', ...))
    const nowIso = new Date().toISOString();
    const { error: softErr } = await supabase
      .from('sales_orders')
      .update({ deleted_at: nowIso })
      .in('id', Array.from(deleteIds));

    if (softErr) {
      console.error(softErr);
      void reconciliar(); // nada foi gravado: o servidor devolve os pedidos
      toast.error(`Erro ao excluir pedidos`, { description: softErr.message });
      return;
    }

    // 2. Omie exclude sequencial (não floodar). Rollback do deleted_at em falhas.
    const failedIds: string[] = [];
    const motivos: string[] = [];
    let success = 0;
    for (const o of toDelete) {
      try {
        const { error } = await supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'excluir_pedido',
            sales_order_id: o.id,
            omie_pedido_id: o.omie_pedido_id,
          },
        });
        if (error) throw error;
        success++;
      } catch (e) {
        failedIds.push(o.id);
        // o texto da edge (ex.: "o pedido existe no Omie — cancele lá") vem no corpo, não no message
        motivos.push((await mensagemDoErroEdge(e)) ?? mensagemDeErro(e) ?? 'falha ao excluir no Omie');
        console.error(e);
      }
    }
    const failed = failedIds.length;

    // Rollback do soft-delete só pros que falharam no Omie
    let rollbackFalhou: string | null = null;
    if (failedIds.length > 0) {
      // Só desfaz a marca que ESTE lote gravou (mesmo carimbo) — nunca a de outra exclusão.
      const { error: rbErr } = await supabase
        .from('sales_orders')
        .update({ deleted_at: null })
        .in('id', failedIds)
        .eq('deleted_at', nowIso);
      if (rbErr) rollbackFalhou = rbErr.message;
    }
    const detalhe = [
      ...new Set(motivos),
      ...(rollbackFalhou ? [`Os que falharam ficaram OCULTOS no app (falha ao desfazer: ${rollbackFalhou}) — avise o suporte.`] : []),
    ].join(' · ') || undefined;

    if (failed === 0) {
      toast.success(`${success} pedido(s) excluído(s)`);
    } else if (success === 0) {
      toast.error(`Falhou: ${failed} pedido(s) não puderam ser excluídos`, { description: detalhe });
    } else {
      toast.warning(`${success} excluído(s), ${failed} falharam`, { description: detalhe });
    }
    // Reconcilia com o servidor em qualquer desfecho do bulk: os que falharam (deleted_at já
    // revertido) voltam à lista; os que ficaram ocultos por falha do rollback, não — é o estado real.
    void reconciliar();
  };

  const toggleSelect = (row: OrderFeedRow, checked: boolean) => {
    if (emTransicao) return; // linha da aba/filtro anterior: não entra nem sai da seleção agora
    setSelecionados((prev) => {
      const next = new Map(prev);
      if (checked) next.set(row.id, row);
      else next.delete(row.id);
      return next;
    });
  };

  const clearSelection = () => setSelecionados(new Map());

  return {
    navigate,
    authLoading,
    loading: feedQuery.isLoading,
    loadError: feedQuery.isError,
    // Refetch de FUNDO que falhou com o cache na tela (a lista segue, a tela avisa discretamente).
    refetchError: feedQuery.isRefetchError,
    // Sem rede e sem cache: a query PAUSA (networkMode 'online') com isLoading=false e lista vazia —
    // sem isto a tela diria "Nenhum pedido ainda".
    pausadoSemDados: feedQuery.isPending && feedQuery.fetchStatus === 'paused',
    // Quando os dados na tela chegaram do servidor (faixa "Sem conexão — mostrando dados de HH:MM").
    dataUpdatedAt: feedQuery.dataUpdatedAt,
    refetch: feedQuery.refetch,
    // Busca/aba nova a caminho com a lista anterior na tela (placeholderData): seleção e ações suspensas.
    buscando: emTransicao,
    hasNextPage: feedQuery.hasNextPage,
    fetchNextPage: feedQuery.fetchNextPage,
    isFetchingNextPage: feedQuery.isFetchingNextPage,
    nextPageError: feedQuery.isFetchNextPageError,
    accountFilter,
    setAccountFilter,
    statusFilter,
    setStatusFilter,
    periodo,
    setPeriodo,
    ordem,
    setOrdem,
    search,
    setSearch,
    limparFiltros,
    comFiltro,
    clienteFiltro,
    limparCliente,
    selectedIds,
    // As LINHAS selecionadas (inclusive as que a busca/aba atual tirou da tela) — o diálogo de
    // exclusão em lote mostra o alcance real, não só a contagem.
    linhasSelecionadas: [...selecionados.values()],
    toggleSelect,
    clearSelection,
    orders,
    totalCount,
    deleteOrder,
    deleteSelected,
    excluindoIds,
    handleShareOrder,
    printOrder,
    prefetchDetail,
  };
}
