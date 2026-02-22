import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { KanbanBoard } from '@/components/KanbanBoard';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Users, ChevronRight, Clock, MapPin, Mail, BarChart3, Trophy, Gamepad2, BookOpen } from 'lucide-react';

interface OrderWithProfile {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  items: unknown;
  total: number;
  delivery_option: string;
  user_id: string;
  profiles?: {
    name: string;
    document: string | null;
    phone: string | null;
  };
}

const Admin = () => {
  const navigate = useNavigate();
  const { user, isStaff, isAdmin, loading: authLoading } = useAuth();
  const { toast } = useToast();
  
  const [orders, setOrders] = useState<OrderWithProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingOrder, setUpdatingOrder] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !isStaff) {
      navigate('/', { replace: true });
    }
  }, [authLoading, isStaff, navigate]);

  useEffect(() => {
    if (user && isStaff) {
      loadOrders();
    }
  }, [user, isStaff]);

  const loadOrders = async () => {
    try {
      const { data, error } = await supabase
        .from('orders')
        .select(`
          *,
          profiles!orders_user_id_fkey (
            name,
            document,
            phone
          )
        `)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error loading orders:', error);
        // Try without join if foreign key doesn't exist
        const { data: ordersOnly } = await supabase
          .from('orders')
          .select('*')
          .order('created_at', { ascending: false });
        
        if (ordersOnly) {
          // Load profiles separately
          const userIds = [...new Set(ordersOnly.map(o => o.user_id))];
          const { data: profiles } = await supabase
            .from('profiles')
            .select('user_id, name, document, phone')
            .in('user_id', userIds);

          const ordersWithProfiles = ordersOnly.map(order => ({
            ...order,
            profiles: profiles?.find(p => p.user_id === order.user_id),
          }));
          
          setOrders(ordersWithProfiles as OrderWithProfile[]);
        }
      } else {
        setOrders((data || []) as unknown as OrderWithProfile[]);
      }
    } catch (error) {
      console.error('Error loading orders:', error);
    } finally {
      setLoading(false);
    }
  };

  const updateOrderStatus = async (orderId: string, newStatus: string) => {
    setUpdatingOrder(orderId);
    try {
      const { error } = await supabase
        .from('orders')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', orderId);

      if (error) throw error;

      toast({
        title: 'Status atualizado!',
        description: `Status do pedido atualizado com sucesso`,
      });

      loadOrders();
    } catch (error) {
      console.error('Error updating order:', error);
      toast({
        title: 'Erro ao atualizar',
        description: 'Não foi possível atualizar o status',
        variant: 'destructive',
      });
    } finally {
      setUpdatingOrder(null);
    }
  };


  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Painel Admin" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  if (!isStaff) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header 
        title={isAdmin ? 'Painel Admin' : 'Painel Funcionário'}
        showBack 
      />

      <main className="pt-16 px-4 max-w-4xl mx-auto">
        {/* Quick actions */}
        <div className="space-y-2 mb-6">
          <Button 
            variant="outline" 
            className="w-full justify-between"
            onClick={() => navigate('/admin/customers')}
          >
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4" />
              <span>Gerenciar Clientes e Ferramentas</span>
            </div>
            <ChevronRight className="w-4 h-4" />
          </Button>
          
          <Button 
            variant="outline" 
            className="w-full justify-between border-amber-300 bg-amber-50 hover:bg-amber-100"
            onClick={() => navigate('/admin/demand-forecast')}
          >
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-amber-600" />
              <span className="text-amber-900">Previsão de Demanda</span>
            </div>
            <ChevronRight className="w-4 h-4 text-amber-600" />
          </Button>
          
          <Button 
            variant="outline" 
            className="w-full justify-between border-emerald-300 bg-emerald-50 hover:bg-emerald-100"
            onClick={() => navigate('/admin/route-planner')}
          >
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-emerald-600" />
              <span className="text-emerald-900">Roteirizador</span>
            </div>
            <ChevronRight className="w-4 h-4 text-emerald-600" />
          </Button>
          
          <Button 
            variant="outline" 
            className="w-full justify-between border-blue-300 bg-blue-50 hover:bg-blue-100"
            onClick={() => navigate('/admin/monthly-reports')}
          >
            <div className="flex items-center gap-2">
              <Mail className="w-4 h-4 text-blue-600" />
              <span className="text-blue-900">Relatório Mensal</span>
            </div>
            <ChevronRight className="w-4 h-4 text-blue-600" />
          </Button>
          
          <Button 
            variant="outline" 
            className="w-full justify-between border-purple-300 bg-purple-50 hover:bg-purple-100"
            onClick={() => navigate('/admin/productivity')}
          >
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-purple-600" />
              <span className="text-purple-900">Produtividade</span>
            </div>
            <ChevronRight className="w-4 h-4 text-purple-600" />
          </Button>
          
          <Button 
            variant="outline" 
            className="w-full justify-between border-yellow-300 bg-yellow-50 hover:bg-yellow-100"
            onClick={() => navigate('/admin/loyalty')}
          >
            <div className="flex items-center gap-2">
              <Trophy className="w-4 h-4 text-yellow-600" />
              <span className="text-yellow-900">Programa de Fidelidade</span>
            </div>
            <ChevronRight className="w-4 h-4 text-yellow-600" />
          </Button>
          
          <Button 
            variant="outline" 
            className="w-full justify-between border-rose-300 bg-rose-50 hover:bg-rose-100"
            onClick={() => navigate('/admin/gamification')}
          >
            <div className="flex items-center gap-2">
              <Gamepad2 className="w-4 h-4 text-rose-600" />
              <span className="text-rose-900">Ranking de Gamificação</span>
            </div>
            <ChevronRight className="w-4 h-4 text-rose-600" />
          </Button>
          
          <Button 
            variant="outline" 
            className="w-full justify-between border-teal-300 bg-teal-50 hover:bg-teal-100"
            onClick={() => navigate('/admin/training')}
          >
            <div className="flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-teal-600" />
              <span className="text-teal-900">Treinamentos Técnicos</span>
            </div>
            <ChevronRight className="w-4 h-4 text-teal-600" />
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <Card className="text-center">
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold text-foreground">{orders.length}</p>
              <p className="text-xs text-muted-foreground">Total</p>
            </CardContent>
          </Card>
          <Card className="text-center">
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold text-amber-600">
                {orders.filter(o => !['entregue'].includes(o.status)).length}
              </p>
              <p className="text-xs text-muted-foreground">Pendentes</p>
            </CardContent>
          </Card>
          <Card className="text-center">
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold text-emerald-600">
                {orders.filter(o => o.status === 'entregue').length}
              </p>
              <p className="text-xs text-muted-foreground">Entregues</p>
            </CardContent>
          </Card>
        </div>

        {/* Kanban Board */}
        <KanbanBoard
          orders={orders}
          onStatusChange={updateOrderStatus}
          updatingOrder={updatingOrder}
        />
      </main>

      <BottomNav />
    </div>
  );
};


export default Admin;
