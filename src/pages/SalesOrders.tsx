import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2, ShoppingCart, Plus, Package } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface SalesOrder {
  id: string;
  customer_user_id: string;
  items: Array<{ descricao: string; quantidade: number; valor_unitario: number; valor_total: number }>;
  subtotal: number;
  total: number;
  status: string;
  omie_numero_pedido: string | null;
  created_at: string;
  notes: string | null;
}

const statusLabels: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  rascunho: { label: 'Rascunho', variant: 'outline' },
  enviado: { label: 'Enviado ao Omie', variant: 'default' },
  faturado: { label: 'Faturado', variant: 'secondary' },
  cancelado: { label: 'Cancelado', variant: 'destructive' },
};

const SalesOrders = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading } = useAuth();
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !isStaff) navigate('/', { replace: true });
  }, [authLoading, isStaff, navigate]);

  useEffect(() => {
    if (isStaff) loadOrders();
  }, [isStaff]);

  const loadOrders = async () => {
    try {
      const { data, error } = await supabase
        .from('sales_orders')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      const salesOrders = (data || []) as unknown as SalesOrder[];
      setOrders(salesOrders);

      // Load customer names
      const customerIds = [...new Set(salesOrders.map((o) => o.customer_user_id))];
      if (customerIds.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('user_id, name')
          .in('user_id', customerIds);
        const map: Record<string, string> = {};
        (profs || []).forEach((p: any) => { map[p.user_id] = p.name; });
        setProfiles(map);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Pedidos de Venda" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Pedidos de Venda" showBack />

      <main className="pt-16 px-4 max-w-4xl mx-auto">
        <div className="flex gap-2 mb-4">
          <Button onClick={() => navigate('/sales/new')} className="gap-2 flex-1">
            <Plus className="w-4 h-4" />
            Novo Pedido
          </Button>
          <Button variant="outline" onClick={() => navigate('/sales/products')} className="gap-2">
            <Package className="w-4 h-4" />
            Catálogo
          </Button>
        </div>

        {orders.length === 0 ? (
          <div className="text-center py-12">
            <ShoppingCart className="w-12 h-12 mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-muted-foreground">Nenhum pedido de venda ainda.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {orders.map((order) => {
              const status = statusLabels[order.status] || statusLabels.rascunho;
              const totalItems = order.items?.reduce((s, i) => s + (i.quantidade || 0), 0) || 0;
              return (
                <Card key={order.id}>
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">
                          {profiles[order.customer_user_id] || 'Cliente'}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {format(new Date(order.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                        </p>
                        {order.omie_numero_pedido && (
                          <p className="text-xs text-muted-foreground">
                            PV: {order.omie_numero_pedido}
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0 space-y-1">
                        <Badge variant={status.variant}>{status.label}</Badge>
                        <p className="text-sm font-bold">R$ {order.total.toFixed(2)}</p>
                        <p className="text-xs text-muted-foreground">{totalItems} itens</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </main>

      <BottomNav />
    </div>
  );
};

export default SalesOrders;
