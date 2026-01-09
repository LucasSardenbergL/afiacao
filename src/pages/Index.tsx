import { PlusCircle, ClipboardList, Headphones, ChevronRight, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { BottomNav } from '@/components/BottomNav';
import { OrderCard } from '@/components/OrderCard';
import { mockOrders, mockUser } from '@/data/mockData';

const Index = () => {
  const navigate = useNavigate();
  const recentOrders = mockOrders.slice(0, 2);
  const hasActiveOrder = mockOrders.some(
    (order) => order.status !== 'entregue'
  );

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Header */}
      <header className="bg-gradient-dark text-secondary-foreground px-4 pt-12 pb-8">
        <div className="max-w-lg mx-auto">
          <div className="flex items-center justify-between mb-6">
            <div>
              <p className="text-sm text-secondary-foreground/70">Olá,</p>
              <h1 className="text-2xl font-display font-bold">{mockUser.name}</h1>
            </div>
            <div className="w-12 h-12 rounded-full bg-primary flex items-center justify-center">
              <span className="text-lg font-bold text-primary-foreground">
                {mockUser.name.charAt(0)}
              </span>
            </div>
          </div>

          {/* Quick stats */}
          {hasActiveOrder && (
            <div className="bg-secondary-foreground/10 rounded-xl p-4 backdrop-blur-sm">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1">
                  <p className="text-sm text-secondary-foreground/70">Pedido em andamento</p>
                  <p className="font-semibold">{mockOrders.find(o => o.status !== 'entregue')?.orderNumber}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate('/orders')}
                  className="text-secondary-foreground"
                >
                  Ver
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="px-4 -mt-4 max-w-lg mx-auto">
        {/* Action cards */}
        <div className="grid grid-cols-3 gap-3 mb-8">
          <button
            onClick={() => navigate('/new-order')}
            className="bg-card rounded-xl p-4 shadow-medium border border-border hover:shadow-strong hover:border-primary/50 transition-smooth flex flex-col items-center gap-2"
          >
            <div className="w-12 h-12 rounded-full bg-gradient-primary flex items-center justify-center shadow-glow">
              <PlusCircle className="w-6 h-6 text-primary-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground">Novo Pedido</span>
          </button>

          <button
            onClick={() => navigate('/orders')}
            className="bg-card rounded-xl p-4 shadow-medium border border-border hover:shadow-strong transition-smooth flex flex-col items-center gap-2"
          >
            <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center">
              <ClipboardList className="w-6 h-6 text-secondary-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground">Meus Pedidos</span>
          </button>

          <button
            onClick={() => navigate('/support')}
            className="bg-card rounded-xl p-4 shadow-medium border border-border hover:shadow-strong transition-smooth flex flex-col items-center gap-2"
          >
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
              <Headphones className="w-6 h-6 text-muted-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground">Suporte</span>
          </button>
        </div>

        {/* Recent orders */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-display font-bold text-foreground">Pedidos Recentes</h2>
            <button
              onClick={() => navigate('/orders')}
              className="text-sm font-medium text-primary flex items-center gap-1"
            >
              Ver todos
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-3">
            {recentOrders.length > 0 ? (
              recentOrders.map((order) => (
                <OrderCard key={order.id} order={order} />
              ))
            ) : (
              <div className="bg-card rounded-xl p-8 text-center border border-border">
                <div className="w-16 h-16 rounded-full bg-muted mx-auto mb-4 flex items-center justify-center">
                  <ClipboardList className="w-8 h-8 text-muted-foreground" />
                </div>
                <h3 className="font-semibold text-foreground mb-1">Nenhum pedido ainda</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Faça seu primeiro pedido de afiação
                </p>
                <Button onClick={() => navigate('/new-order')}>
                  <PlusCircle className="w-4 h-4 mr-2" />
                  Novo Pedido
                </Button>
              </div>
            )}
          </div>
        </section>

        {/* Promo banner */}
        <section className="mt-8">
          <div className="bg-gradient-primary rounded-xl p-5 text-primary-foreground relative overflow-hidden">
            <div className="relative z-10">
              <h3 className="font-display font-bold text-lg mb-1">
                Primeira afiação?
              </h3>
              <p className="text-sm text-primary-foreground/80 mb-3">
                Ganhe 10% de desconto no primeiro pedido
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate('/new-order')}
              >
                Usar cupom
              </Button>
            </div>
            <div className="absolute right-0 bottom-0 w-32 h-32 opacity-10">
              <Sparkles className="w-full h-full" />
            </div>
          </div>
        </section>
      </main>

      <BottomNav />
    </div>
  );
};

export default Index;
