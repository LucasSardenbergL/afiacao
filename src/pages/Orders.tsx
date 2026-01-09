import { useState } from 'react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { OrderCard } from '@/components/OrderCard';
import { mockOrders } from '@/data/mockData';
import { cn } from '@/lib/utils';

type FilterTab = 'all' | 'active' | 'completed';

const Orders = () => {
  const [activeTab, setActiveTab] = useState<FilterTab>('all');

  const filteredOrders = mockOrders.filter((order) => {
    if (activeTab === 'active') return order.status !== 'entregue';
    if (activeTab === 'completed') return order.status === 'entregue';
    return true;
  });

  const tabs: { id: FilterTab; label: string; count: number }[] = [
    { id: 'all', label: 'Todos', count: mockOrders.length },
    { id: 'active', label: 'Em andamento', count: mockOrders.filter(o => o.status !== 'entregue').length },
    { id: 'completed', label: 'Concluídos', count: mockOrders.filter(o => o.status === 'entregue').length },
  ];

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
              <p className="text-muted-foreground">Nenhum pedido encontrado</p>
            </div>
          )}
        </div>
      </main>

      <BottomNav />
    </div>
  );
};

export default Orders;
