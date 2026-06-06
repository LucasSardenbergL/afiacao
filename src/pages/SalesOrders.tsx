import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, ShoppingCart, Trash2, ChevronLeft } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { BulkActionsBar } from '@/components/ui/bulk-actions-bar';
import { decodeHtml, PAGE_SIZE, type SalesOrder } from '@/components/salesOrders/types';
import { useSalesOrders } from '@/components/salesOrders/useSalesOrders';
import { SalesOrdersToolbar } from '@/components/salesOrders/SalesOrdersToolbar';
import { SalesOrderCard } from '@/components/salesOrders/SalesOrderCard';
import { SalesOrderDetailSheet } from '@/components/salesOrders/SalesOrderDetailSheet';

const SalesOrders = () => {
  const {
    navigate,
    authLoading,
    loading,
    accountFilter,
    setAccountFilter,
    search,
    setSearch,
    selectedIds,
    toggleSelect,
    clearSelection,
    orders,
    profiles,
    filteredOrders,
    hasNext,
    isFetching,
    sentinelRef,
    loadMore,
    deleteOrder,
    deleteSelected,
    handleShareOrder,
    printOrder,
  } = useSalesOrders();

  const [detailOrder, setDetailOrder] = useState<SalesOrder | null>(null);
  const detailCustomerName = detailOrder
    ? decodeHtml(profiles[detailOrder.customer_user_id] || 'Cliente')
    : '';

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center pt-32">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
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
              key={`${order._source}-${order.id}`}
              order={order}
              customerName={decodeHtml(profiles[order.customer_user_id] || 'Cliente')}
              checked={selectedIds.has(order.id)}
              onSelectChange={(v) => toggleSelect(order.id, v)}
              onShare={() => handleShareOrder(order, decodeHtml(profiles[order.customer_user_id] || 'Cliente'))}
              onDelete={() => deleteOrder(order)}
              onNavigate={navigate}
              onOpenDetail={() => setDetailOrder(order)}
              onPrint={() => printOrder(order)}
            />
          ))}

          {/* Infinite scroll sentinel + carregar mais fallback */}
          {hasNext && (
            <div ref={sentinelRef} className="py-4 flex justify-center">
              {isFetching ? (
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadMore}
                >
                  Carregar mais
                </Button>
              )}
            </div>
          )}
          {!hasNext && orders.length >= PAGE_SIZE && (
            <p className="text-center text-xs text-muted-foreground py-4">
              Todos os pedidos carregados ({orders.length})
            </p>
          )}
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
        order={detailOrder}
        customerName={detailCustomerName}
        onClose={() => setDetailOrder(null)}
        onPrint={() => detailOrder && printOrder(detailOrder)}
        onShare={() => detailOrder && handleShareOrder(detailOrder, detailCustomerName)}
        onEdit={() => detailOrder && navigate(`/sales/edit/${detailOrder.id}`)}
      />
    </div>
  );
};

export default SalesOrders;
