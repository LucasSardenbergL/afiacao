import { useMemo, useRef, useState } from 'react';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { Button } from '@/components/ui/button';
import { ShoppingCart, Trash2, ChevronLeft, Loader2, AlertTriangle, WifiOff, Plus, X as XIcon } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { BulkActionsBar } from '@/components/ui/bulk-actions-bar';
import { agruparPorDia, chaveDaLinha, decodeHtml, EFEITO_DA_EXCLUSAO, type OrderFeedRow } from '@/components/salesOrders/types';
import { ALCANCE_VAZIO, alcanceDaExclusao, type AlcanceExclusao } from '@/components/salesOrders/alcance-exclusao';
import { useSalesOrders } from '@/components/salesOrders/useSalesOrders';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { useSalesOrderDetail } from '@/components/salesOrders/useSalesOrderDetail';
import { useDescontosItensPedido } from '@/components/salesOrders/useDescontosItensPedido';
import { SalesOrdersAcoes, SalesOrdersToolbar } from '@/components/salesOrders/SalesOrdersToolbar';
import { GRADE_LINHA_PEDIDO, SalesOrderCard } from '@/components/salesOrders/SalesOrderCard';
import { SELETOR_LINHA, useTecladoPedidos } from '@/components/salesOrders/useTecladoPedidos';
import { SalesOrderDetailSheet } from '@/components/salesOrders/SalesOrderDetailSheet';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { track } from '@/lib/analytics';
import { format } from 'date-fns';

const SalesOrders = () => {
  const {
    navigate,
    authLoading,
    loading,
    loadError,
    refetchError,
    pausadoSemDados,
    dataUpdatedAt,
    refetch,
    buscando,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    nextPageError,
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
    linhasSelecionadas,
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
  } = useSalesOrders();
  // Carrega a próxima página quando o fim da lista chega perto. Depois de uma falha, para: o botão
  // "Tentar de novo" decide (sem ele, o sentinela visível re-dispararia em laço).
  const sentinelaRef = useInfiniteScroll(
    () => fetchNextPage(),
    !!hasNextPage && !isFetchingNextPage && !nextPageError,
  );

  // Pedido selecionado na listagem → o painel busca o detalhe completo por id.
  const [detailRow, setDetailRow] = useState<OrderFeedRow | null>(null);
  const detailQuery = useSalesOrderDetail(detailRow);
  // Desconto de cada item (order_items) para o painel: a query vai INTEIRA, com o estado, para
  // "não consegui ler" não chegar lá como "sem desconto".
  const descontosItensQuery = useDescontosItensPedido(detailRow);
  // Alcance do lote calculado ao ABRIR o diálogo (não a cada render da lista): `null` = fechado. O
  // último alcance fica guardado para o diálogo não piscar "0 pedidos" na animação de fechar.
  const [alcanceLote, setAlcanceLote] = useState<AlcanceExclusao | null>(null);
  const [confirmandoLote, setConfirmandoLote] = useState(false);
  // Confirmação de exclusão individual: UM diálogo na página, fora das linhas (dentro delas o clique
  // no fundo do diálogo propagava pela árvore React até a linha e abria o detalhe — Codex 2ª rodada).
  const [pedidoAExcluir, setPedidoAExcluir] = useState<OrderFeedRow | null>(null);
  const gatilhoExclusaoRef = useRef<HTMLElement | null>(null);
  // O cabeçalho do dia gruda ABAIXO da barra fixa do app (h-topbar; +1.75rem com a faixa do "Ver como").
  const { isImpersonating } = useImpersonation();
  const { online } = useNetworkStatus();

  // Teclado: linha ativa (roving tabindex), busca focável por "/" e retorno de foco ao fechar o painel.
  const listaRef = useRef<HTMLDivElement>(null);
  const buscaRef = useRef<HTMLInputElement>(null);
  const [linhaAtiva, setLinhaAtiva] = useState<string | null>(null);
  const origemDoDetalheRef = useRef<string | null>(null);
  const { mover, anuncio } = useTecladoPedidos({
    listaRef,
    buscaRef,
    orders,
    selectedIds,
    toggleSelect,
    navigate,
    setStatusFilter,
    limparFiltros,
    comFiltro,
    buscando,
    bloqueado: !!detailRow || !!pedidoAExcluir || confirmandoLote,
  });

  // Ações das linhas: as MESMAS funções para todas (o hook devolve funções novas a cada render, então
  // a ref guarda a última). Com elas estáveis, o `memo` do SalesOrderCard re-renderiza só a linha
  // que mudou — marcar um checkbox em 1.000 linhas renderizava as 1.000.
  const atual = useRef({ toggleSelect, handleShareOrder, printOrder, prefetchDetail, navigate });
  atual.current = { toggleSelect, handleShareOrder, printOrder, prefetchDetail, navigate };
  const acoesDaLinha = useMemo(() => ({
    onNavigate: (path: string) => atual.current.navigate(path),
    onSelectChange: (order: OrderFeedRow, v: boolean) => atual.current.toggleSelect(order, v),
    onShare: (order: OrderFeedRow) => void atual.current.handleShareOrder(order),
    onPrint: (order: OrderFeedRow) => void atual.current.printOrder(order),
    onPrefetch: (order: OrderFeedRow) => atual.current.prefetchDetail(order),
    onPedirExclusao: (order: OrderFeedRow, gatilho: HTMLElement | null) => {
      gatilhoExclusaoRef.current = gatilho;
      setPedidoAExcluir(order);
    },
    onOpenDetail: (order: OrderFeedRow, chave: string) => {
      origemDoDetalheRef.current = chave;
      setDetailRow(order);
    },
  }), []);

  // "Maior valor" desliga os grupos por dia: agrupar reordenaria por data e quebraria a ordem
  // prometida. Aí a linha mostra a data no lugar da hora. Memo: só a lista muda os grupos.
  const porValor = ordem === 'valor';
  const grupos = useMemo(
    () => (porValor ? [{ dia: 'valor', rotulo: '', pedidos: orders }] : agruparPorDia(orders)),
    [porValor, orders],
  );
  const chaves = useMemo(() => new Set(orders.map(chaveDaLinha)), [orders]);

  if (authLoading || loading) {
    return (
      <PageSkeleton variant="list" />
    );
  }

  // Erro só derruba a tela quando NÃO há dados — refetch de fundo que falha não
  // descarta um cache válido com milhares de pedidos (codex P2).
  if ((loadError || pausadoSemDados) && orders.length === 0) {
    return (
      <div className="max-w-4xl mx-auto pt-8">
        <EmptyState
          tone="operational"
          icon={online ? AlertTriangle : WifiOff}
          title="Não foi possível carregar os pedidos"
          description={online ? 'O servidor não respondeu. Tente de novo em instantes.' : 'Sem conexão com a internet.'}
          actionLabel="Tentar de novo"
          onAction={() => refetch()}
        />
      </div>
    );
  }

  const alcance = alcanceLote ?? ALCANCE_VAZIO;
  const horaDosDados = dataUpdatedAt ? format(new Date(dataUpdatedAt), 'HH:mm') : null;
  // Roving tabindex: a linha ativa fica no Tab; se ela saiu da lista (filtro), a primeira assume.
  const primeira = grupos[0]?.pedidos[0];
  const chaveFocavel = linhaAtiva && chaves.has(linhaAtiva) ? linhaAtiva : primeira ? chaveDaLinha(primeira) : null;

  return (
    <div className="max-w-6xl mx-auto space-y-4 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground" onClick={() => navigate(-1)} aria-label="Voltar">
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="font-display text-2xl leading-tight">Pedidos</h1>
            <p className="text-xs text-muted-foreground">Vendas e afiação das três empresas</p>
          </div>
        </div>
        <SalesOrdersAcoes onNavigate={navigate} />
      </div>
      {/* Anúncio da seleção por teclado (o nome da linha não muda ao marcar). */}
      <p role="status" className="sr-only">{anuncio}</p>

      {clienteFiltro && (
        <div className="flex items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted pl-2.5 pr-1 py-1">
            <span>
              Pedidos de{' '}
              <span className="font-medium">
                {/* O nome vem das linhas já filtradas; sem linha (cliente sem pedido), não inventa nome. */}
                {orders.find((o) => o.customer_name)?.customer_name ?? 'um cliente'}
              </span>
            </span>
            <button
              type="button"
              onClick={limparCliente}
              className="p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="Ver pedidos de todos os clientes"
            >
              <XIcon className="w-3 h-3" />
            </button>
          </span>
        </div>
      )}

      <SalesOrdersToolbar
        accountFilter={accountFilter}
        setAccountFilter={setAccountFilter}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        periodo={periodo}
        setPeriodo={setPeriodo}
        ordem={ordem}
        setOrdem={setOrdem}
        search={search}
        setSearch={setSearch}
        buscando={buscando}
        buscaRef={buscaRef}
      />

      {!online && orders.length > 0 && (
        <p role="status" className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs text-status-warning">
          <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {horaDosDados ? `Sem conexão — mostrando dados de ${horaDosDados}` : 'Sem conexão — mostrando os últimos dados carregados'}
        </p>
      )}
      {online && refetchError && orders.length > 0 && (
        <p role="status" className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-status-warning" aria-hidden />
          {horaDosDados ? `Não consegui atualizar a lista — mostrando dados de ${horaDosDados}.` : 'Não consegui atualizar a lista.'}
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => refetch()}>
            Tentar de novo
          </button>
        </p>
      )}

      {orders.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title={comFiltro ? 'Nenhum pedido com esses filtros' : 'Nenhum pedido ainda'}
          description={
            comFiltro
              ? 'Tente ajustar a busca, o status, o período ou a aba de empresa.'
              : 'Crie seu primeiro pedido pra começar a operar.'
          }
          actionLabel={comFiltro ? 'Limpar filtros' : 'Novo pedido'}
          onAction={() => {
            if (comFiltro) {
              limparFiltros();
            } else {
              navigate('/sales/new');
            }
          }}
        />
      ) : (
        <div className={cn('rounded-lg border bg-card transition-opacity', buscando && 'opacity-60')} aria-busy={buscando || undefined}>
          {/* Semântica de TABELA para o leitor de tela; a linha é focável (roving tabindex — ver
              useTecladoPedidos). O cabeçalho de colunas só APARECE no desktop, mas existe para o leitor
              também no celular (sr-only). */}
          <div ref={listaRef} role="table" aria-label="Pedidos" aria-describedby="sales-dica-teclado">
            <p id="sales-dica-teclado" className="sr-only">
              Use j e k ou as setas para mover entre os pedidos, Enter para abrir e x para selecionar.
            </p>
            <div role="rowgroup">
              <div
                role="row"
                className={cn(
                  GRADE_LINHA_PEDIDO,
                  'sr-only md:not-sr-only md:grid border-b px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground',
                )}
              >
                <span role="columnheader" className="[grid-area:check]"><span className="sr-only">Seleção</span></span>
                <span role="columnheader" className="[grid-area:cliente]">Cliente</span>
                <span role="columnheader" className="[grid-area:pv]">PV</span>
                <span role="columnheader" className="[grid-area:empresa]">Empresa</span>
                <span role="columnheader" className="[grid-area:status]">Status</span>
                <span role="columnheader" className="[grid-area:total] text-right">Total</span>
                <span role="columnheader" className="[grid-area:acoes]"><span className="sr-only">Ações</span></span>
              </div>
            </div>

            {grupos.map((grupo) => (
              <div role="rowgroup" key={grupo.dia} aria-label={porValor ? 'Pedidos por maior valor' : grupo.rotulo}>
                {!porValor && (
                  // O sticky fica na LINHA (filha direta do grupo): no h2 de dentro ele só grudaria na própria linha.
                  <div role="row" className={cn('sticky z-[1] border-b bg-muted/70 px-3 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-muted/50', isImpersonating ? 'top-[calc(theme(spacing.topbar)+1.75rem)]' : 'top-topbar')}>
                    <div role="cell" aria-colspan={7}>
                      <h2 className="text-xs font-medium text-muted-foreground">{grupo.rotulo}</h2>
                    </div>
                  </div>
                )}
                <div className="divide-y">
                  {grupo.pedidos.map((order) => {
                    const chave = chaveDaLinha(order);
                    return (
                      <SalesOrderCard
                        key={chave}
                        order={order}
                        customerName={decodeHtml(order.customer_name || 'Cliente')}
                        // A seleção é por id de sales_orders: uma afiação com o mesmo id não acende junto.
                        checked={order.origin === 'sales' && selectedIds.has(order.id)}
                        onSelectChange={acoesDaLinha.onSelectChange}
                        onShare={acoesDaLinha.onShare}
                        onPedirExclusao={acoesDaLinha.onPedirExclusao}
                        excluindo={order.origin === 'sales' && excluindoIds.has(order.id)}
                        suspenso={buscando}
                        mostrarData={porValor}
                        onNavigate={acoesDaLinha.onNavigate}
                        onOpenDetail={acoesDaLinha.onOpenDetail}
                        onPrint={acoesDaLinha.onPrint}
                        onPrefetch={acoesDaLinha.onPrefetch}
                        focavel={chave === chaveFocavel}
                        onFocusLinha={setLinhaAtiva}
                        onMover={mover}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div ref={sentinelaRef} className="flex flex-col items-center gap-2 border-t py-4 text-xs text-muted-foreground">
            {isFetchingNextPage && <Loader2 aria-label="Carregando mais pedidos" className="w-4 h-4 animate-spin" />}
            {nextPageError && (
              <Button variant="outline" size="sm" onClick={() => fetchNextPage()}>
                Não carregou o resto — tentar de novo
              </Button>
            )}
            <p>{rodapeDaLista(orders.length, totalCount, !!hasNextPage, !!search.trim())}</p>
          </div>
        </div>
      )}

      {/* Barra flutuante quando há seleção múltipla */}
      <BulkActionsBar
        count={selectedIds.size}
        onClear={clearSelection}
        itemSingular="pedido"
        itemPlural="pedidos"
        actions={[
          {
            id: 'delete',
            label: 'Excluir',
            icon: Trash2,
            variant: 'destructive',
            // Filtro novo a caminho: espera a lista certa antes de abrir o alcance do lote.
            disabled: buscando,
            onClick: () => {
              // Na transição de filtro as linhas na tela são do filtro ANTERIOR: não contam como "na tela".
              setAlcanceLote(alcanceDaExclusao(linhasSelecionadas, buscando ? [] : orders));
              setConfirmandoLote(true);
            },
          },
        ]}
      />

      {/* Exclusão em lote: mostra o ALCANCE (empresas e pedidos fora da tela atual) — a seleção
          sobrevive à troca de busca/aba, e um "Excluir 5?" sem contexto apagaria o que ninguém vê. */}
      <AlertDialog open={confirmandoLote} onOpenChange={setConfirmandoLote}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Excluir {plural(alcance.total, 'pedido', 'pedidos')}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>{alcance.porEmpresa.map(([empresa, n]) => `${empresa}: ${n}`).join(' · ')}</p>
                {alcance.foraDaTela > 0 && (
                  <p className="font-medium text-status-warning">
                    {alcance.foraDaTela === 1
                      ? '1 pedido selecionado não está na lista atual (outra busca ou aba).'
                      : `${alcance.foraDaTela} pedidos selecionados não estão na lista atual (outra busca ou aba).`}
                  </p>
                )}
                <p>{EFEITO_DA_EXCLUSAO}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={buscando}
              onClick={() => {
                track('sales.lote_excluir', { n: alcance.total });
                void deleteSelected();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Excluir {plural(alcance.total, 'pedido', 'pedidos')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pedidoAExcluir} onOpenChange={(aberto) => !aberto && setPedidoAExcluir(null)}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            // Devolve o foco ao "⋯" de onde a exclusão saiu (se a linha ainda existir).
            const gatilho = gatilhoExclusaoRef.current;
            if (gatilho?.isConnected) {
              e.preventDefault();
              gatilho.focus();
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Excluir o pedido{pedidoAExcluir?.order_number ? ` ${pedidoAExcluir.order_number.replace(/^0+/, '') || '0'}` : ''}
              {pedidoAExcluir ? ` de ${decodeHtml(pedidoAExcluir.customer_name || 'Cliente')}` : ''}?
            </AlertDialogTitle>
            <AlertDialogDescription>{EFEITO_DA_EXCLUSAO}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pedidoAExcluir && deleteOrder(pedidoAExcluir)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Celular: "Novo pedido" ao alcance do polegar. Some com a seleção — a BulkActionsBar ocupa o rodapé. */}
      {selectedIds.size === 0 && (
        <Button
          size="touch"
          onClick={() => navigate('/sales/new')}
          className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-40 gap-2 rounded-full shadow-lg md:hidden"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Novo pedido
        </Button>
      )}

      <SalesOrderDetailSheet
        open={!!detailRow}
        loading={detailQuery.isPending}
        erro={detailQuery.isError}
        onRetry={() => void detailQuery.refetch()}
        order={detailQuery.data?.order ?? null}
        resumo={detailRow ? {
          status: detailRow.status,
          account: detailRow.account,
          pv: detailRow.order_number,
          total: Number(detailRow.total),
          created_at: detailRow.created_at,
        } : null}
        onCloseAutoFocus={(e) => {
          // Painel controlado sem trigger: o foco volta à linha de onde ele abriu; se ela saiu da lista
          // (o feed mudou com o painel aberto), à primeira linha; com a lista vazia, à busca.
          const chave = origemDoDetalheRef.current;
          const linhas = Array.from(listaRef.current?.querySelectorAll<HTMLElement>(SELETOR_LINHA) ?? []);
          const alvo = linhas.find((el) => el.dataset.linhaPedido === chave) ?? linhas[0] ?? buscaRef.current;
          if (alvo) {
            e.preventDefault();
            alvo.focus();
          }
        }}
        customerName={detailQuery.data?.customerName ?? decodeHtml(detailRow?.customer_name || 'Cliente')}
        descontosItens={descontosItensQuery}
        onClose={() => setDetailRow(null)}
        onPrint={() => {
          if (!detailRow) return;
          track('sales.pedido_acao', { acao: 'imprimir', via: 'painel' });
          void printOrder(detailRow);
        }}
        onShare={() => {
          if (!detailRow) return;
          track('sales.pedido_acao', { acao: 'compartilhar', via: 'painel' });
          void handleShareOrder(detailRow);
        }}
        onEdit={() => {
          if (!detailRow) return;
          track('sales.pedido_acao', { acao: 'editar', via: 'painel' });
          navigate(`/sales/edit/${detailRow.id}`);
        }}
        onRepeat={() => {
          const o = detailQuery.data?.order;
          if (o) {
            track('sales.pedido_acao', { acao: 'repetir', via: 'painel' });
            navigate(`/sales/new?customer=${o.customer_user_id}&repeat=${o.id}`);
          }
        }}
      />
    </div>
  );
};

function plural(n: number, um: string, varios: string): string {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? um : varios}`;
}

// O total só vem sem busca (com busca contaria os ~32 k de novo — ver useSalesOrders).
function rodapeDaLista(carregados: number, total: number | null, temMais: boolean, comBusca: boolean): string {
  const n = (v: number) => v.toLocaleString('pt-BR');
  if (total !== null) return carregados >= total ? `${n(total)} ${total === 1 ? 'pedido' : 'pedidos'}` : `${n(carregados)} de ${n(total)} pedidos`;
  const rotulo = comBusca
    ? (carregados === 1 ? 'encontrado' : 'encontrados')
    : (carregados === 1 ? 'pedido' : 'pedidos');
  return temMais ? `${n(carregados)} ${rotulo} até aqui — role para ver mais` : `${n(carregados)} ${rotulo}`;
}

export default SalesOrders;
