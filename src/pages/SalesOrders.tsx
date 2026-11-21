import { useRef, useState } from 'react';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { Button } from '@/components/ui/button';
import { ShoppingCart, Trash2, ChevronLeft, Loader2, AlertTriangle, WifiOff } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { BulkActionsBar } from '@/components/ui/bulk-actions-bar';
import { agruparPorDia, decodeHtml, EFEITO_DA_EXCLUSAO, rotuloEmpresa, type OrderFeedRow } from '@/components/salesOrders/types';
import { useSalesOrders } from '@/components/salesOrders/useSalesOrders';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { useSalesOrderDetail } from '@/components/salesOrders/useSalesOrderDetail';
import { useDescontosItensPedido } from '@/components/salesOrders/useDescontosItensPedido';
import { SalesOrdersAcoes, SalesOrdersToolbar } from '@/components/salesOrders/SalesOrdersToolbar';
import { GRADE_LINHA_PEDIDO, SalesOrderCard } from '@/components/salesOrders/SalesOrderCard';
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
  const [confirmandoLote, setConfirmandoLote] = useState(false);
  // Confirmação de exclusão individual: UM diálogo na página, fora das linhas (dentro delas o clique
  // no fundo do diálogo propagava pela árvore React até a linha e abria o detalhe — Codex 2ª rodada).
  const [pedidoAExcluir, setPedidoAExcluir] = useState<OrderFeedRow | null>(null);
  const gatilhoExclusaoRef = useRef<HTMLElement | null>(null);
  // O cabeçalho do dia gruda ABAIXO da barra fixa do app (h-topbar; +1.75rem com a faixa do "Ver como").
  const { isImpersonating } = useImpersonation();
  const { online } = useNetworkStatus();

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

  // "Maior valor" desliga os grupos por dia: agrupar reordenaria por data e quebraria a ordem
  // prometida. Aí a linha mostra a data no lugar da hora.
  const porValor = ordem === 'valor';
  const grupos = porValor
    ? [{ dia: 'valor', rotulo: '', pedidos: orders }]
    : agruparPorDia(orders);
  // Na transição de filtro as linhas na tela são do filtro ANTERIOR: não contam como "na tela".
  const alcance = alcanceDaExclusao(linhasSelecionadas, buscando ? [] : orders);
  const horaDosDados = dataUpdatedAt ? format(new Date(dataUpdatedAt), 'HH:mm') : null;

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
          {/* Cabeçalho de colunas — só no desktop; usa a MESMA grade da linha. */}
          <div
            className={cn(
              GRADE_LINHA_PEDIDO,
              'hidden md:grid border-b px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground',
            )}
            aria-hidden
          >
            <span className="[grid-area:check]" />
            <span className="[grid-area:cliente]">Cliente</span>
            <span className="[grid-area:pv]">PV</span>
            <span className="[grid-area:empresa]">Empresa</span>
            <span className="[grid-area:status]">Status</span>
            <span className="[grid-area:total] text-right">Total</span>
            <span className="[grid-area:acoes]" />
          </div>

          {grupos.map((grupo) => (
            <section key={grupo.dia} aria-label={porValor ? 'Pedidos por maior valor' : grupo.rotulo}>
              {!porValor && (
                <h2 className={cn('sticky z-[1] border-b bg-muted/70 px-3 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur supports-[backdrop-filter]:bg-muted/50', isImpersonating ? 'top-[calc(theme(spacing.topbar)+1.75rem)]' : 'top-topbar')}>
                  {grupo.rotulo}
                </h2>
              )}
              <div className="divide-y">
                {grupo.pedidos.map((order) => (
                  <SalesOrderCard
                    key={`${order.origin}-${order.id}`}
                    order={order}
                    customerName={decodeHtml(order.customer_name || 'Cliente')}
                    // A seleção é por id de sales_orders: uma afiação com o mesmo id não acende junto.
                    checked={order.origin === 'sales' && selectedIds.has(order.id)}
                    onSelectChange={(v) => toggleSelect(order, v)}
                    onShare={() => handleShareOrder(order)}
                    onPedirExclusao={(gatilho) => {
                      gatilhoExclusaoRef.current = gatilho;
                      setPedidoAExcluir(order);
                    }}
                    excluindo={order.origin === 'sales' && excluindoIds.has(order.id)}
                    suspenso={buscando}
                    mostrarData={porValor}
                    onNavigate={navigate}
                    onOpenDetail={() => setDetailRow(order)}
                    onPrint={() => printOrder(order)}
                    onPrefetch={() => prefetchDetail(order)}
                  />
                ))}
              </div>
            </section>
          ))}

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
            onClick: () => setConfirmandoLote(true),
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

      <SalesOrderDetailSheet
        open={!!detailRow}
        loading={detailQuery.isPending}
        order={detailQuery.data?.order ?? null}
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

function alcanceDaExclusao(selecionadas: OrderFeedRow[], naTela: OrderFeedRow[]) {
  const visiveis = new Set(naTela.filter((o) => o.origin === 'sales').map((o) => o.id));
  const contagem = new Map<string, number>();
  for (const o of selecionadas) {
    const empresa = rotuloEmpresa(o.account);
    contagem.set(empresa, (contagem.get(empresa) ?? 0) + 1);
  }
  return {
    total: selecionadas.length,
    porEmpresa: [...contagem.entries()],
    foraDaTela: selecionadas.filter((o) => !visiveis.has(o.id)).length,
  };
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
