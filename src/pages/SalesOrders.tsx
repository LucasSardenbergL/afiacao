import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ShoppingCart, Trash2, ChevronLeft, Loader2 } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { BulkActionsBar } from '@/components/ui/bulk-actions-bar';
import { decodeHtml, type OrderFeedRow } from '@/components/salesOrders/types';
import { useSalesOrders } from '@/components/salesOrders/useSalesOrders';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { useSalesOrderDetail } from '@/components/salesOrders/useSalesOrderDetail';
import { useDescontosItensPedido } from '@/components/salesOrders/useDescontosItensPedido';
import { SalesOrdersToolbar } from '@/components/salesOrders/SalesOrdersToolbar';
import { SalesOrderCard } from '@/components/salesOrders/SalesOrderCard';
import { SalesOrderDetailSheet } from '@/components/salesOrders/SalesOrderDetailSheet';

const SalesOrders = () => {
  const {
    navigate,
    authLoading,
    loading,
    loadError,
    refetch,
    buscando,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    nextPageError,
    accountFilter,
    setAccountFilter,
    search,
    setSearch,
    selectedIds,
    toggleSelect,
    clearSelection,
    orders,
    totalCount,
    deleteOrder,
    deleteSelected,
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

  if (authLoading || loading) {
    return (
      <PageSkeleton variant="list" />
    );
  }

  // Erro só derruba a tela quando NÃO há dados — refetch de fundo que falha não
  // descarta um cache válido com milhares de pedidos (codex P2).
  if (loadError && orders.length === 0) {
    return (
      <div className="max-w-4xl mx-auto pt-16 text-center space-y-3">
        <p className="text-sm text-muted-foreground">Não foi possível carregar os pedidos.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4 pb-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-lg font-semibold">Pedidos</h1>
          <p className="text-xs text-muted-foreground">Gerencie todos os seus pedidos de venda e afiação</p>
        </div>
      </div>

      <SalesOrdersToolbar
        onNavigate={navigate}
        accountFilter={accountFilter}
        setAccountFilter={setAccountFilter}
        search={search}
        setSearch={setSearch}
        buscando={buscando}
      />

      {orders.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title={search.trim() || accountFilter !== 'all' ? 'Nenhum pedido com esses filtros' : 'Nenhum pedido ainda'}
          description={
            search.trim() || accountFilter !== 'all'
              ? 'Tente ajustar a busca ou trocar a aba de empresa.'
              : 'Crie seu primeiro pedido pra começar a operar.'
          }
          actionLabel={search.trim() || accountFilter !== 'all' ? 'Limpar filtros' : 'Novo pedido'}
          onAction={() => {
            if (search.trim() || accountFilter !== 'all') {
              setSearch('');
              setAccountFilter('all');
            } else {
              navigate('/sales/new');
            }
          }}
        />
      ) : (
        <div className="space-y-2">
          {orders.map((order) => (
            <SalesOrderCard
              key={`${order.origin}-${order.id}`}
              order={order}
              customerName={decodeHtml(order.customer_name || 'Cliente')}
              checked={selectedIds.has(order.id)}
              onSelectChange={(v) => toggleSelect(order, v)}
              onShare={() => handleShareOrder(order)}
              onDelete={() => deleteOrder(order)}
              onNavigate={navigate}
              onOpenDetail={() => setDetailRow(order)}
              onPrint={() => printOrder(order)}
              onPrefetch={() => prefetchDetail(order)}
            />
          ))}
          <div ref={sentinelaRef} className="flex flex-col items-center gap-2 py-4 text-xs text-muted-foreground">
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
            onClick: () => {
              if (confirm(`Excluir ${selectedIds.size} pedido(s)? Esta ação não pode ser desfeita.`)) {
                deleteSelected();
              }
            },
          },
        ]}
      />

      <SalesOrderDetailSheet
        open={!!detailRow}
        loading={detailQuery.isPending}
        order={detailQuery.data?.order ?? null}
        customerName={detailQuery.data?.customerName ?? decodeHtml(detailRow?.customer_name || 'Cliente')}
        descontosItens={descontosItensQuery}
        onClose={() => setDetailRow(null)}
        onPrint={() => detailRow && printOrder(detailRow)}
        onShare={() => detailRow && handleShareOrder(detailRow)}
        onEdit={() => detailRow && navigate(`/sales/edit/${detailRow.id}`)}
        onRepeat={() => {
          const o = detailQuery.data?.order;
          if (o) navigate(`/sales/new?customer=${o.customer_user_id}&repeat=${o.id}`);
        }}
      />
    </div>
  );
};

// O total só vem sem busca (com busca contaria os ~32 k de novo — ver useSalesOrders).
function rodapeDaLista(carregados: number, total: number | null, temMais: boolean, comBusca: boolean): string {
  const n = (v: number) => v.toLocaleString('pt-BR');
  if (total !== null) return carregados >= total ? `${n(total)} pedido(s)` : `${n(carregados)} de ${n(total)} pedido(s)`;
  const rotulo = comBusca ? 'encontrado(s)' : 'pedido(s)';
  return temMais ? `${n(carregados)} ${rotulo} até aqui — role para ver mais` : `${n(carregados)} ${rotulo}`;
}

export default SalesOrders;
