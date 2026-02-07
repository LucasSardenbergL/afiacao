import { useState, useEffect } from 'react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { OrderCard } from '@/components/OrderCard';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, Package } from 'lucide-react';

type FilterTab = 'all' | 'active' | 'completed';

interface Order {
  id: string;
  status: string;
  service_type: string;
  items: any[];
  total: number;
  created_at: string;
  delivery_option: string;
}

const Orders = () => {
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadOrders = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (!error && data) {
        setOrders(data as Order[]);
      }
      setLoading(false);
    };

    loadOrders();
  }, []);

  const filteredOrders = orders.filter((order) => {
    if (activeTab === 'active') return order.status !== 'entregue';
    if (activeTab === 'completed') return order.status === 'entregue';
    return true;
  });

  const tabs: { id: FilterTab; label: string; count: number }[] = [
    { id: 'all', label: 'Todos', count: orders.length },
    { id: 'active', label: 'Em andamento', count: orders.filter(o => o.status !== 'entregue').length },
    { id: 'completed', label: 'Concluídos', count: orders.filter(o => o.status === 'entregue').length },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Meus Pedidos" showBack showNotifications />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Tabs */}
        <div className="flex gap-2 mb-6 overflow-x-auto no-scrollbar py-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-smooth',
                activeTab === tab.id
                  ? 'bg-secondary text-secondary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              )}
            >
              {tab.label}
              <span className="ml-1.5 text-xs opacity-70">({tab.count})</span>
            </button>
          ))}
        </div>

        {/* Orders list */}
        <div className="space-y-3">
          {filteredOrders.length > 0 ? (
            filteredOrders.map((order) => (
              <OrderCard key={order.id} order={order} />
            ))
          ) : (
            <div className="text-center py-12">
              <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
                <Package className="w-8 h-8 text-muted-foreground" />
              </div>
              <p className="text-muted-foreground mb-2">Nenhum pedido encontrado</p>
              <p className="text-sm text-muted-foreground/70">
                Seus pedidos aparecerão aqui
              </p>
            </div>
          )}
        </div>
      </main>

      <BottomNav />
    </div>
  );
};

export default Orders;
