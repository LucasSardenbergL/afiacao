import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { OrderCard } from '@/components/OrderCard';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2, Package, Plus, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';

type FilterTab = 'pending' | 'active' | 'completed' | 'all';

const PAGE_SIZE = 20;

interface OrderRow {
  id: string;
  status: string;
  items: any;
  total: number;
  created_at: string;
  service_type: string;
}

const FILTER_CONFIG: Record<FilterTab, { label: string; emptyTitle: string; emptyDesc: string }> = {
  pending: { label: 'Pendentes', emptyTitle: 'Nenhum orçamento pendente', emptyDesc: 'Quando houver orçamentos para aprovar, eles aparecerão aqui.' },
  active: { label: 'Em andamento', emptyTitle: 'Nenhum pedido em andamento', emptyDesc: 'Seus pedidos ativos aparecerão aqui.' },
  completed: { label: 'Concluídos', emptyTitle: 'Nenhum pedido concluído', emptyDesc: 'Pedidos finalizados aparecerão aqui.' },
  all: { label: 'Todos', emptyTitle: 'Nenhum pedido encontrado', emptyDesc: 'Seus pedidos aparecerão aqui.' },
};

const Orders = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [allOrders, setAllOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // Initial fetch
  const fetchOrders = useCallback(async (offset = 0, append = false) => {
    if (!user?.id) return;
    if (offset === 0) setLoading(true); else setLoadingMore(true);

    const { data, error } = await supabase
      .from('orders')
      .select('id, status, items, total, created_at, service_type')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (!error && data) {
      setAllOrders(prev => append ? [...prev, ...data as OrderRow[]] : data as OrderRow[]);
      setHasMore(data.length === PAGE_SIZE);
    }
    setLoading(false);
    setLoadingMore(false);
  }, [user?.id]);

  useEffect(() => { fetchOrders(0); }, [fetchOrders]);

  // Realtime subscription
  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel(`orders-user-${user.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'orders',
        filter: `user_id=eq.${user.id}`,
      }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const newOrder = payload.new as OrderRow;
          setAllOrders(prev => {
            if (prev.some(o => o.id === newOrder.id)) return prev;
            return [newOrder, ...prev];
          });
        } else if (payload.eventType === 'UPDATE') {
          const updated = payload.new as OrderRow;
          setAllOrders(prev => prev.map(o => o.id === updated.id ? { ...o, ...updated } : o));
        } else if (payload.eventType === 'DELETE') {
          const deleted = payload.old as { id: string };
          setAllOrders(prev => prev.filter(o => o.id !== deleted.id));
        }
        // Also invalidate dashboard queries
        queryClient.invalidateQueries({ queryKey: ['orders'] });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user?.id, queryClient]);

  // Derived counts & filtered list
  const counts = useMemo(() => ({
    pending: allOrders.filter(o => o.status === 'orcamento_enviado').length,
    active: allOrders.filter(o => o.status !== 'entregue' && o.status !== 'orcamento_enviado').length,
    completed: allOrders.filter(o => o.status === 'entregue').length,
    all: allOrders.length,
  }), [allOrders]);

  const filteredOrders = useMemo(() => {
    switch (activeTab) {
      case 'pending': return allOrders.filter(o => o.status === 'orcamento_enviado');
      case 'active': return allOrders.filter(o => o.status !== 'entregue' && o.status !== 'orcamento_enviado');
      case 'completed': return allOrders.filter(o => o.status === 'entregue');
      default: return allOrders;
    }
  }, [allOrders, activeTab]);

  const handleLoadMore = () => fetchOrders(allOrders.length, true);

  const tabConfig = FILTER_CONFIG[activeTab];

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const totalEmpty = allOrders.length === 0;

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Meus Pedidos" showBack showNotifications />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* New Order */}
        <div className="mb-4">
          <Button onClick={() => navigate('/new-order')} className="w-full gap-2">
            <Plus className="w-4 h-4" />
            Novo Pedido de Afiação
          </Button>
        </div>

        {/* Pending alert banner */}
        {counts.pending > 0 && activeTab !== 'pending' && (
          <button
            onClick={() => setActiveTab('pending')}
            className="w-full mb-4 flex items-center gap-3 p-3 rounded-xl border border-status-warning/40 bg-status-warning-bg/50 text-left transition-colors hover:bg-status-warning-bg"
          >
            <AlertCircle className="w-5 h-5 text-status-warning flex-shrink-0" />
            <span className="text-sm font-medium text-foreground">
              {counts.pending === 1 ? 'Você tem 1 orçamento pendente de aprovação' : `Você tem ${counts.pending} orçamentos pendentes`}
            </span>
          </button>
        )}

        {/* Tabs */}
        <div className="flex gap-2 mb-6 overflow-x-auto no-scrollbar py-1">
          {(Object.entries(FILTER_CONFIG) as [FilterTab, typeof tabConfig][]).map(([id, cfg]) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={cn(
                'px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-smooth',
                activeTab === id
                  ? id === 'pending' && counts.pending > 0
                    ? 'bg-status-warning text-status-warning-foreground'
                    : 'bg-secondary text-secondary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              )}
            >
              {cfg.label}
              <span className="ml-1.5 text-xs opacity-70">({counts[id]})</span>
            </button>
          ))}
        </div>

        {/* Orders list */}
        <div className="space-y-3">
          {filteredOrders.length > 0 ? (
            <>
              {filteredOrders.map((order) => (
                <OrderCard key={order.id} order={order} />
              ))}
              {activeTab === 'all' && hasMore && (
                <Button
                  variant="outline"
                  className="w-full rounded-xl"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Carregar mais
                </Button>
              )}
            </>
          ) : (
            <div className="text-center py-12">
              <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
                <Package className="w-8 h-8 text-muted-foreground" />
              </div>
              <p className="font-semibold text-foreground mb-1">{totalEmpty ? 'Nenhum pedido ainda' : tabConfig.emptyTitle}</p>
              <p className="text-sm text-muted-foreground mb-4">{totalEmpty ? 'Crie seu primeiro pedido de afiação!' : tabConfig.emptyDesc}</p>
              {totalEmpty && (
                <Button onClick={() => navigate('/new-order')} className="gap-2">
                  <Plus className="w-4 h-4" />
                  Novo Pedido
                </Button>
              )}
            </div>
          )}
        </div>
      </main>

      <BottomNav />
    </div>
  );
};

export default Orders;
