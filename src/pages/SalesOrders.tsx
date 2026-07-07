import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ShoppingCart, Trash2, ChevronLeft, TriangleAlert } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { BulkActionsBar } from '@/components/ui/bulk-actions-bar';
import { decodeHtml, type OrderFeedRow } from '@/components/salesOrders/types';
import { useSalesOrders, FEED_MAX_TOTAL } from '@/components/salesOrders/useSalesOrders';
import { useSalesOrderDetail } from '@/components/salesOrders/useSalesOrderDetail';
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
    accountFilter,
    setAccountFilter,
    search,
    setSearch,
    selectedIds,
    toggleSelect,
    clearSelection,
    filteredOrders,
    totalCount,
    truncated,
    deleteOrder,
    deleteSelected,
    handleShareOrder,
    printOrder,
    prefetchDetail,
    orders,
  } = useSalesOrders();

  // Pedido selecionado na listagem → o painel busca o detalhe completo por id.
  const [detailRow, setDetailRow] = useState<OrderFeedRow | null>(null);
  const detailQuery = useSalesOrderDetail(detailRow);

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
      />

      {/* Aviso honesto: o feed bateu o teto de segurança — a busca não cobre tudo */}
      {truncated && (
        <div className="flex items-center gap-2 text-xs text-status-warning bg-status-warning-bg border border-status-warning/30 rounded-md px-3 py-2">
          <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
          <span>
            Mostrando os primeiros {FEED_MAX_TOTAL.toLocaleString('pt-BR')} de {totalCount.toLocaleString('pt-BR')} pedidos — a busca cobre só esses.
          </span>
        </div>
      )}

      {filteredOrders.length === 0 ? (
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
          {filteredOrders.map((order) => (
            <SalesOrderCard
              key={`${order.origin}-${order.id}`}
              order={order}
              customerName={decodeHtml(order.customer_name || 'Cliente')}
              checked={selectedIds.has(order.id)}
              onSelectChange={(v) => toggleSelect(order.id, v)}
              onShare={() => handleShareOrder(order)}
              onDelete={() => deleteOrder(order)}
              onNavigate={navigate}
              onOpenDetail={() => setDetailRow(order)}
              onPrint={() => printOrder(order)}
              onPrefetch={() => prefetchDetail(order)}
            />
          ))}
          <p className="text-center text-xs text-muted-foreground py-4">
            {filteredOrders.length === totalCount
              ? `${totalCount} pedido(s)`
              : `${filteredOrders.length} de ${totalCount} pedido(s)`}
          </p>
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

export default SalesOrders;
