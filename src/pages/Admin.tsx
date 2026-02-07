import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Package, Users, Wrench, ChevronRight, Clock, Truck, CheckCircle, Building2 } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

// Employee-specific order statuses
const EMPLOYEE_ORDER_STATUS = {
  pedido_recebido: { label: 'Pedido Recebido', icon: Package, color: 'bg-blue-500' },
  aguardando_coleta: { label: 'Aguardando Coleta', icon: Clock, color: 'bg-amber-500' },
  em_triagem: { label: 'Coletado e na Empresa', icon: Building2, color: 'bg-purple-500' },
  em_rota: { label: 'A Caminho da Entrega', icon: Truck, color: 'bg-amber-500' },
  entregue: { label: 'Entregue', icon: CheckCircle, color: 'bg-emerald-500' },
};

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
  const [selectedTab, setSelectedTab] = useState('pending');

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
        description: `Pedido alterado para: ${EMPLOYEE_ORDER_STATUS[newStatus as keyof typeof EMPLOYEE_ORDER_STATUS]?.label || newStatus}`,
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

  const getNextStatus = (currentStatus: string): string | null => {
    const statusFlow = ['pedido_recebido', 'aguardando_coleta', 'em_triagem', 'em_rota', 'entregue'];
    const currentIndex = statusFlow.indexOf(currentStatus);
    if (currentIndex < statusFlow.length - 1) {
      return statusFlow[currentIndex + 1];
    }
    return null;
  };

  const filterOrders = (status: string) => {
    if (status === 'pending') {
      return orders.filter(o => !['entregue'].includes(o.status));
    }
    if (status === 'completed') {
      return orders.filter(o => o.status === 'entregue');
    }
    return orders;
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

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Quick actions */}
        <div className="mb-6">
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

        {/* Tabs */}
        <Tabs value={selectedTab} onValueChange={setSelectedTab}>
          <TabsList className="grid w-full grid-cols-2 mb-4">
            <TabsTrigger value="pending">Pendentes</TabsTrigger>
            <TabsTrigger value="completed">Concluídos</TabsTrigger>
          </TabsList>

          <TabsContent value="pending" className="space-y-3">
            {filterOrders('pending').map(order => (
              <OrderCard 
                key={order.id} 
                order={order}
                onStatusChange={updateOrderStatus}
                updatingOrder={updatingOrder}
                getNextStatus={getNextStatus}
              />
            ))}
            {filterOrders('pending').length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                Nenhum pedido pendente
              </div>
            )}
          </TabsContent>

          <TabsContent value="completed" className="space-y-3">
            {filterOrders('completed').map(order => (
              <OrderCard 
                key={order.id} 
                order={order}
                onStatusChange={updateOrderStatus}
                updatingOrder={updatingOrder}
                getNextStatus={getNextStatus}
              />
            ))}
            {filterOrders('completed').length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                Nenhum pedido concluído
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>

      <BottomNav />
    </div>
  );
};

interface OrderCardProps {
  order: OrderWithProfile;
  onStatusChange: (orderId: string, status: string) => Promise<void>;
  updatingOrder: string | null;
  getNextStatus: (status: string) => string | null;
}

const OrderCard = ({ order, onStatusChange, updatingOrder, getNextStatus }: OrderCardProps) => {
  const statusInfo = EMPLOYEE_ORDER_STATUS[order.status as keyof typeof EMPLOYEE_ORDER_STATUS];
  const nextStatus = getNextStatus(order.status);
  const StatusIcon = statusInfo?.icon || Package;
  const items = Array.isArray(order.items) ? order.items : [];

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div>
            <p className="font-semibold text-foreground">
              {order.profiles?.name || 'Cliente'}
            </p>
            {order.profiles?.document && (
              <p className="text-xs text-muted-foreground">
                Doc: {order.profiles.document}
              </p>
            )}
          </div>
          <Badge variant="secondary" className={`${statusInfo?.color || 'bg-gray-500'} text-white`}>
            {statusInfo?.label || order.status}
          </Badge>
        </div>

        <div className="space-y-1 text-sm text-muted-foreground mb-3">
          <p>📅 {format(new Date(order.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}</p>
          <p>🔧 {items.length} {items.length === 1 ? 'item' : 'itens'}</p>
          {order.total > 0 && <p>💰 R$ {order.total.toFixed(2)}</p>}
        </div>

        {nextStatus && (
          <Button
            size="sm"
            className="w-full"
            disabled={updatingOrder === order.id}
            onClick={() => onStatusChange(order.id, nextStatus)}
          >
            {updatingOrder === order.id ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : null}
            Avançar para: {EMPLOYEE_ORDER_STATUS[nextStatus as keyof typeof EMPLOYEE_ORDER_STATUS]?.label}
          </Button>
        )}
      </CardContent>
    </Card>
  );
};

export default Admin;
