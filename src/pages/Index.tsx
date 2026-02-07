import { useEffect, useState } from 'react';
import { PlusCircle, ClipboardList, Headphones, ChevronRight, Wrench, Calendar, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { BottomNav } from '@/components/BottomNav';
import { SharpeningSuggestions } from '@/components/SharpeningSuggestions';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface Profile {
  name: string;
  customer_type: string | null;
}

interface Order {
  id: string;
  status: string;
  created_at: string;
  service_type: string;
}

interface UserTool {
  id: string;
  tool_category_id: string;
  next_sharpening_due: string | null;
  sharpening_interval_days: number | null;
  tool_categories: {
    name: string;
  };
}

const Index = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pendingOrders, setPendingOrders] = useState<Order[]>([]);
  const [userTools, setUserTools] = useState<UserTool[]>([]);
  // toolsDue moved to SharpeningSuggestions component
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      if (!user) return;

      try {
        // Load profile
        const { data: profileData } = await supabase
          .from('profiles')
          .select('name, customer_type')
          .eq('user_id', user.id)
          .single();

        if (profileData) {
          setProfile(profileData);
        }

        // Load pending orders (not delivered)
        const { data: ordersData } = await supabase
          .from('orders')
          .select('id, status, created_at, service_type')
          .eq('user_id', user.id)
          .neq('status', 'entregue')
          .order('created_at', { ascending: false });

        if (ordersData) {
          setPendingOrders(ordersData);
        }

        // Load user tools with categories
        const { data: toolsData } = await supabase
          .from('user_tools')
          .select(`
            id,
            tool_category_id,
            next_sharpening_due,
            sharpening_interval_days,
            tool_categories (name)
          `)
          .eq('user_id', user.id);

        if (toolsData) {
          setUserTools(toolsData as unknown as UserTool[]);
        }
      } catch (error) {
        console.error('Error loading data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [user]);

  const getStatusLabel = (status: string): string => {
    const labels: Record<string, string> = {
      'pedido_recebido': 'Recebido',
      'aguardando_coleta': 'Aguardando Coleta',
      'em_triagem': 'Em Triagem',
      'orcamento_enviado': 'Orçamento Enviado',
      'aprovado': 'Aprovado',
      'em_afiacao': 'Em Afiação',
      'controle_qualidade': 'Controle de Qualidade',
      'pronto_entrega': 'Pronto para Entrega',
      'em_rota': 'Em Rota',
      'entregue': 'Entregue',
    };
    return labels[status] || status;
  };

  const firstName = profile?.name?.split(' ')[0] || 'Cliente';

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Header */}
      <header className="bg-gradient-dark text-secondary-foreground px-4 pt-12 pb-8">
        <div className="max-w-lg mx-auto">
          <div className="flex items-center justify-between mb-6">
            <div>
              <p className="text-sm text-secondary-foreground/70">Olá,</p>
              <h1 className="text-2xl font-display font-bold">{firstName}</h1>
              {profile?.customer_type && (
                <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full mt-1 ${
                  profile.customer_type === 'industrial' 
                    ? 'bg-amber-500/20 text-amber-300' 
                    : 'bg-blue-500/20 text-blue-300'
                }`}>
                  {profile.customer_type === 'industrial' ? 'Industrial' : 'Doméstico'}
                </span>
              )}
            </div>
            <button 
              onClick={() => navigate('/profile')}
              className="w-12 h-12 rounded-full bg-primary flex items-center justify-center"
            >
              <User className="w-6 h-6 text-primary-foreground" />
            </button>
          </div>

          {/* Quick Summary */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-secondary-foreground/10 rounded-xl p-4 backdrop-blur-sm">
              <p className="text-xs text-secondary-foreground/70">Pedidos Pendentes</p>
              <p className="text-2xl font-bold">{pendingOrders.length}</p>
            </div>
            <div className="bg-secondary-foreground/10 rounded-xl p-4 backdrop-blur-sm">
              <p className="text-xs text-secondary-foreground/70">Ferramentas Cadastradas</p>
              <p className="text-2xl font-bold">{userTools.length}</p>
            </div>
          </div>
        </div>
      </header>

      <main className="px-4 -mt-4 max-w-lg mx-auto">
        {/* Sharpening Suggestions */}
        <section className="mb-6">
          <SharpeningSuggestions compact />
        </section>

        {/* Action cards */}
        <div className="grid grid-cols-3 gap-3 mb-6">
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

        {/* Pending Orders */}
        {pendingOrders.length > 0 && (
          <section className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-display font-bold text-foreground">Pedidos em Andamento</h2>
              <button
                onClick={() => navigate('/orders')}
                className="text-sm font-medium text-primary flex items-center gap-1"
              >
                Ver todos
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              {pendingOrders.slice(0, 3).map((order) => (
                <button
                  key={order.id}
                  onClick={() => navigate(`/orders/${order.id}`)}
                  className="w-full bg-card rounded-xl p-4 border border-border hover:border-primary/50 transition-smooth text-left"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-foreground">
                        {format(new Date(order.created_at), "dd 'de' MMM", { locale: ptBR })}
                      </p>
                      <p className="text-sm text-muted-foreground capitalize">{order.service_type}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-2 py-1 rounded-full bg-primary/10 text-primary font-medium">
                        {getStatusLabel(order.status)}
                      </span>
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* My Tools */}
        {userTools.length > 0 && (
          <section className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-display font-bold text-foreground">Minhas Ferramentas</h2>
              <button
                onClick={() => navigate('/profile')}
                className="text-sm font-medium text-primary flex items-center gap-1"
              >
                Gerenciar
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {userTools.slice(0, 4).map((tool) => (
                <div
                  key={tool.id}
                  className="bg-card rounded-xl p-3 border border-border"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                      <Wrench className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <p className="font-medium text-sm text-foreground truncate">
                      {tool.tool_categories?.name}
                    </p>
                  </div>
                  {tool.next_sharpening_due && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      Próxima: {format(new Date(tool.next_sharpening_due), "dd/MM")}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Empty state for new users */}
        {pendingOrders.length === 0 && userTools.length === 0 && (
          <div className="bg-card rounded-xl p-8 text-center border border-border">
            <div className="w-16 h-16 rounded-full bg-muted mx-auto mb-4 flex items-center justify-center">
              <Wrench className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-foreground mb-1">Bem-vindo à Colacor!</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Faça seu primeiro pedido de afiação
            </p>
            <Button onClick={() => navigate('/new-order')}>
              <PlusCircle className="w-4 h-4 mr-2" />
              Novo Pedido
            </Button>
          </div>
        )}

        {/* Info card about industrial pricing */}
        {profile?.customer_type === 'industrial' && (
          <section className="mt-6">
            <div className="bg-gradient-primary rounded-xl p-5 text-primary-foreground relative overflow-hidden">
              <div className="relative z-10">
                <h3 className="font-display font-bold text-lg mb-1">
                  Cliente Industrial
                </h3>
                <p className="text-sm text-primary-foreground/80">
                  Você tem frete gratuito em todos os pedidos!
                </p>
              </div>
            </div>
          </section>
        )}
      </main>

      <BottomNav />
    </div>
  );
};

export default Index;
