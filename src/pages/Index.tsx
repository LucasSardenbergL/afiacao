import { useEffect, useState } from 'react';
import { PlusCircle, ClipboardList, ChevronRight, Wrench, Calendar, User, ArrowRight, TrendingUp, Package, Users, Clock, CheckCircle, Building2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

import { CustomerDashboard } from '@/components/CustomerDashboard';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';
import { format, differenceInDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

interface Profile {
  name: string;
  customer_type: string | null;
  document: string | null;
}

interface Order {
  id: string;
  status: string;
  created_at: string;
  service_type: string;
  user_id?: string;
  profiles?: {
    name: string;
  };
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

const statusConfig: Record<string, { label: string; color: string; bgColor: string }> = {
  'pedido_recebido': { label: 'Recebido', color: 'text-blue-700', bgColor: 'bg-blue-100' },
  'aguardando_coleta': { label: 'Aguardando Coleta', color: 'text-amber-700', bgColor: 'bg-amber-100' },
  'em_triagem': { label: 'Em Triagem', color: 'text-purple-700', bgColor: 'bg-purple-100' },
  'orcamento_enviado': { label: 'Orçamento', color: 'text-orange-700', bgColor: 'bg-orange-100' },
  'aprovado': { label: 'Aprovado', color: 'text-emerald-700', bgColor: 'bg-emerald-100' },
  'em_afiacao': { label: 'Em Afiação', color: 'text-primary', bgColor: 'bg-primary/10' },
  'controle_qualidade': { label: 'Qualidade', color: 'text-cyan-700', bgColor: 'bg-cyan-100' },
  'pronto_entrega': { label: 'Pronto!', color: 'text-emerald-700', bgColor: 'bg-emerald-100' },
  'em_rota': { label: 'Em Rota', color: 'text-indigo-700', bgColor: 'bg-indigo-100' },
  'entregue': { label: 'Entregue', color: 'text-muted-foreground', bgColor: 'bg-muted' },
};

const EMPLOYEE_ORDER_STATUS: Record<string, { label: string; color: string }> = {
  pedido_recebido: { label: 'Recebido', color: 'bg-blue-500' },
  aguardando_coleta: { label: 'Aguardando Coleta', color: 'bg-amber-500' },
  em_triagem: { label: 'Coletado', color: 'bg-purple-500' },
  em_rota: { label: 'Em Rota', color: 'bg-amber-500' },
  entregue: { label: 'Entregue', color: 'bg-emerald-500' },
};

const Index = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isStaff, isAdmin, loading: roleLoading } = useUserRole();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pendingOrders, setPendingOrders] = useState<Order[]>([]);
  const [allPendingOrders, setAllPendingOrders] = useState<Order[]>([]);
  const [userTools, setUserTools] = useState<UserTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [customerCount, setCustomerCount] = useState(0);

  useEffect(() => {
    const loadData = async () => {
      if (!user) return;

      try {
        // Load basic profile data for all users
        const profileResult = await supabase
          .from('profiles')
          .select('name, customer_type, document')
          .eq('user_id', user.id)
          .single();

        if (profileResult.data) setProfile(profileResult.data);

        // Load different data based on role
        if (isStaff) {
          // Staff: Load all pending orders and customer count
          const [ordersResult, customersResult] = await Promise.all([
            supabase
              .from('orders')
              .select('id, status, created_at, service_type, user_id')
              .neq('status', 'entregue')
              .order('created_at', { ascending: false })
              .limit(10),
            supabase
              .from('profiles')
              .select('id', { count: 'exact', head: true })
              .or('is_employee.is.null,is_employee.eq.false'),
          ]);

          if (ordersResult.data) {
            const orders = ordersResult.data as unknown as Order[];
            // Fetch profile names for order user_ids
            const userIds = [...new Set(orders.map(o => o.user_id).filter(Boolean))];
            if (userIds.length > 0) {
              const { data: profiles } = await supabase
                .from('profiles')
                .select('user_id, name')
                .in('user_id', userIds as string[]);
              
              const nameMap = new Map(profiles?.map(p => [p.user_id, p.name]) || []);
              orders.forEach(o => {
                if (o.user_id) {
                  o.profiles = { name: nameMap.get(o.user_id) || 'Cliente' };
                }
              });
            }
            setAllPendingOrders(orders);
          }
          if (customersResult.count !== null) setCustomerCount(customersResult.count);
        } else {
          // Customer: Load their own orders and tools
          const [ordersResult, toolsResult] = await Promise.all([
            supabase
              .from('orders')
              .select('id, status, created_at, service_type')
              .eq('user_id', user.id)
              .neq('status', 'entregue')
              .order('created_at', { ascending: false }),
            supabase
              .from('user_tools')
              .select(`
                id,
                tool_category_id,
                next_sharpening_due,
                sharpening_interval_days,
                tool_categories (name)
              `)
              .eq('user_id', user.id),
          ]);

          if (ordersResult.data) setPendingOrders(ordersResult.data);
          if (toolsResult.data) setUserTools(toolsResult.data as unknown as UserTool[]);
        }
      } catch (error) {
        console.error('Error loading data:', error);
      } finally {
        setLoading(false);
      }
    };

    if (!roleLoading) {
      loadData();
    }
  }, [user, isStaff, roleLoading]);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Bom dia';
    if (hour < 18) return 'Boa tarde';
    return 'Boa noite';
  };

  // Para CNPJ mostrar razão social, para CPF mostrar primeiro nome
  const isCNPJ = profile?.document && profile.document.replace(/\D/g, '').length === 14;
  const displayName = isCNPJ 
    ? profile?.name || 'Cliente'
    : profile?.name?.split(' ')[0] || 'Cliente';

  const toolsNeedingSharpening = userTools.filter(tool => {
    if (!tool.next_sharpening_due) return false;
    const daysUntil = differenceInDays(new Date(tool.next_sharpening_due), new Date());
    return daysUntil <= 7;
  });

  if (loading || roleLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    );
  }

  // Employee/Admin Home
  if (isStaff) {
    return (
      <div className="space-y-6">
        {/* Hero Header for Staff */}
        <header className="bg-gradient-dark text-secondary-foreground px-4 pt-12 pb-10 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
          <div className="absolute bottom-0 left-0 w-40 h-40 bg-primary/5 rounded-full blur-2xl translate-y-1/2 -translate-x-1/2" />
          
          <div className="max-w-lg mx-auto relative z-10">
            <div className="flex items-start justify-between mb-8">
              <div className="space-y-1">
                <p className="text-sm text-secondary-foreground/70 font-medium">{getGreeting()},</p>
                <h1 className="text-2xl font-display font-bold tracking-tight">{displayName}</h1>
                <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium bg-primary/20 text-primary-foreground">
                  <Building2 className="w-3 h-3" />
                  {isAdmin ? 'Administrador' : 'Funcionário'}
                </span>
              </div>
              <button 
                onClick={() => navigate('/profile')}
                className="w-12 h-12 rounded-full bg-primary/90 hover:bg-primary flex items-center justify-center transition-all hover:scale-105 shadow-glow"
              >
                <User className="w-6 h-6 text-primary-foreground" />
              </button>
            </div>

            {/* Staff Stats */}
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => navigate('/admin')}
                className="bg-secondary-foreground/10 hover:bg-secondary-foreground/15 rounded-2xl p-4 backdrop-blur-sm border border-secondary-foreground/5 transition-all text-left group"
              >
                <div className="flex items-center justify-between mb-2">
                  <Package className="w-5 h-5 text-secondary-foreground/60" />
                  <ChevronRight className="w-4 h-4 text-secondary-foreground/40 group-hover:translate-x-1 transition-transform" />
                </div>
                <p className="text-3xl font-bold">{allPendingOrders.length}</p>
                <p className="text-xs text-secondary-foreground/60">Pedidos pendentes</p>
              </button>
              <button
                onClick={() => navigate('/admin/customers')}
                className="bg-secondary-foreground/10 hover:bg-secondary-foreground/15 rounded-2xl p-4 backdrop-blur-sm border border-secondary-foreground/5 transition-all text-left group"
              >
                <div className="flex items-center justify-between mb-2">
                  <Users className="w-5 h-5 text-secondary-foreground/60" />
                  <ChevronRight className="w-4 h-4 text-secondary-foreground/40 group-hover:translate-x-1 transition-transform" />
                </div>
                <p className="text-3xl font-bold">{customerCount}</p>
                <p className="text-xs text-secondary-foreground/60">Clientes</p>
              </button>
            </div>
          </div>
        </header>

        <main className="px-4 -mt-5 max-w-lg mx-auto relative z-20">
          {/* CTA Principal - Admin Panel */}
          <Card className="shadow-strong border-0 mb-6 overflow-hidden animate-fade-in">
            <CardContent className="p-0">
              <button
                onClick={() => navigate('/admin')}
                className="w-full p-5 flex items-center gap-4 group hover:bg-muted/30 transition-colors"
              >
                <div className="w-14 h-14 rounded-2xl bg-gradient-primary flex items-center justify-center shadow-glow flex-shrink-0 group-hover:scale-105 transition-transform">
                  <ClipboardList className="w-7 h-7 text-primary-foreground" />
                </div>
                <div className="flex-1 text-left">
                  <h2 className="font-display font-bold text-lg text-foreground">Gerenciar Pedidos</h2>
                  <p className="text-sm text-muted-foreground">Visualize e atualize os pedidos</p>
                </div>
                <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:translate-x-1 group-hover:text-primary transition-all" />
              </button>
            </CardContent>
          </Card>

          {/* Quick Actions for Staff */}
          <div className="grid grid-cols-3 gap-3 mb-6">
            <button
              onClick={() => navigate('/admin')}
              className="bg-card rounded-2xl p-4 shadow-medium border border-border hover:shadow-strong hover:border-primary/30 transition-all flex flex-col items-center gap-2 group"
            >
              <div className="w-11 h-11 rounded-xl bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                <Package className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
              <span className="text-xs font-medium text-foreground">Pedidos</span>
            </button>

            <button
              onClick={() => navigate('/admin/customers')}
              className="bg-card rounded-2xl p-4 shadow-medium border border-border hover:shadow-strong hover:border-primary/30 transition-all flex flex-col items-center gap-2 group"
            >
              <div className="w-11 h-11 rounded-xl bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                <Users className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
              <span className="text-xs font-medium text-foreground">Clientes</span>
            </button>

            <button
              onClick={() => navigate('/admin/demand-forecast')}
              className="bg-card rounded-2xl p-4 shadow-medium border border-border hover:shadow-strong hover:border-primary/30 transition-all flex flex-col items-center gap-2 group"
            >
              <div className="w-11 h-11 rounded-xl bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                <Clock className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
              <span className="text-xs font-medium text-foreground">Previsão</span>
            </button>
          </div>

          {/* Recent Pending Orders for Staff */}
          {allPendingOrders.length > 0 && (
            <section className="mb-6 animate-fade-in" style={{ animationDelay: '0.15s' }}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-display font-bold text-lg text-foreground">Pedidos Recentes</h2>
                <button
                  onClick={() => navigate('/admin')}
                  className="text-sm font-medium text-primary flex items-center gap-1 hover:gap-2 transition-all"
                >
                  Ver todos
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3">
                {allPendingOrders.slice(0, 5).map((order, index) => {
                  const config = EMPLOYEE_ORDER_STATUS[order.status] || { label: order.status, color: 'bg-gray-500' };
                  
                  return (
                    <Card 
                      key={order.id}
                      className="overflow-hidden hover:shadow-medium transition-shadow cursor-pointer group animate-fade-in"
                      style={{ animationDelay: `${0.2 + index * 0.05}s` }}
                      onClick={() => navigate(`/admin/orders/${order.id}`)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
                              <Package className="w-5 h-5 text-muted-foreground" />
                            </div>
                            <div>
                              <p className="font-semibold text-foreground">
                                {order.profiles?.name || 'Cliente'}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {format(new Date(order.created_at), "dd 'de' MMM 'às' HH:mm", { locale: ptBR })}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary" className={`${config.color} text-white text-xs`}>
                              {config.label}
                            </Badge>
                            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:translate-x-1 transition-transform" />
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </section>
          )}

          {allPendingOrders.length === 0 && (
            <Card className="text-center py-8">
              <CardContent>
                <CheckCircle className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
                <p className="font-semibold text-foreground">Tudo em dia!</p>
                <p className="text-sm text-muted-foreground">Nenhum pedido pendente no momento</p>
              </CardContent>
            </Card>
          )}
        </main>

      </div>
    );
  }

  return (
    <CustomerDashboard
      profile={profile}
      pendingOrders={pendingOrders}
      userTools={userTools}
      getGreeting={getGreeting}
    />
  );
};

export default Index;
