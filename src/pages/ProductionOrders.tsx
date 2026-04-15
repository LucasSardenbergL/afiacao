import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2, CheckCircle2, Clock, Package, Factory } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { toast } from 'sonner';
import { decodeHtmlEntities } from '@/lib/utils';

type StatusFilter = 'all' | 'pending' | 'in_progress' | 'completed';

interface ProductionOrder {
  id: string;
  sales_order_id: string | null;
  sales_order_number: string | null;
  customer_name: string | null;
  product_codigo: string | null;
  product_descricao: string | null;
  quantidade: number;
  unidade: string;
  status: string;
  omie_ordem_numero: string | null;
  ready_by_date: string | null;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
}

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: typeof Clock }> = {
  pending: { label: 'Pendente', variant: 'outline', icon: Clock },
  in_progress: { label: 'Em Produção', variant: 'default', icon: Factory },
  completed: { label: 'Finalizada', variant: 'secondary', icon: CheckCircle2 },
  cancelled: { label: 'Cancelada', variant: 'destructive', icon: Clock },
};

const ProductionOrders = () => {
  const { user } = useAuth();
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [finalizingId, setFinalizingId] = useState<string | null>(null);

  useEffect(() => {
    loadOrders();
  }, []);

  const loadOrders = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('production_orders')
      .select('*')
      .order('created_at', { ascending: false });
    if (!error && data) setOrders(data as any);
    setLoading(false);
  };

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return orders;
    return orders.filter(o => o.status === statusFilter);
  }, [orders, statusFilter]);

  const handleFinalize = async (orderId: string) => {
    setFinalizingId(orderId);
    try {
      const { data, error } = await supabase.functions.invoke('omie-vendas-sync', {
        body: { action: 'finalizar_ordem_producao', account: 'colacor', production_order_id: orderId },
      });
      if (error) throw error;
      toast.success('Ordem de produção finalizada!');
      loadOrders();
    } catch (err: any) {
      toast.error(err.message || 'Erro ao finalizar');
    } finally {
      setFinalizingId(null);
    }
  };

  const handleStartProduction = async (orderId: string) => {
    await supabase
      .from('production_orders')
      .update({ status: 'in_progress' } as any)
      .eq('id', orderId);
    toast.success('Produção iniciada!');
    loadOrders();
  };

  const counts = useMemo(() => ({
    all: orders.length,
    pending: orders.filter(o => o.status === 'pending').length,
    in_progress: orders.filter(o => o.status === 'in_progress').length,
    completed: orders.filter(o => o.status === 'completed').length,
  }), [orders]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center gap-2">
        <Factory className="h-6 w-6 text-primary" />
        <h1 className="text-xl font-bold">Ordens de Produção</h1>
      </div>

      <Tabs value={statusFilter} onValueChange={v => setStatusFilter(v as StatusFilter)}>
        <TabsList className="w-full grid grid-cols-4">
          <TabsTrigger value="all">Todas ({counts.all})</TabsTrigger>
          <TabsTrigger value="pending">Pendentes ({counts.pending})</TabsTrigger>
          <TabsTrigger value="in_progress">Em Prod. ({counts.in_progress})</TabsTrigger>
          <TabsTrigger value="completed">Finalizadas ({counts.completed})</TabsTrigger>
        </TabsList>
      </Tabs>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Package className="h-12 w-12 mb-2" />
            <p className="font-medium">Nenhuma ordem de produção</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map(order => {
            const cfg = statusConfig[order.status] || statusConfig.pending;
            const Icon = cfg.icon;
            return (
              <Card key={order.id} className="overflow-hidden">
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm truncate">
                        {decodeHtmlEntities(order.product_descricao) || 'Produto'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {order.product_codigo && `Cód: ${order.product_codigo} · `}
                        Qtd: {order.quantidade} {order.unidade}
                      </p>
                    </div>
                    <Badge variant={cfg.variant} className="flex items-center gap-1 shrink-0">
                      <Icon className="h-3 w-3" />
                      {cfg.label}
                    </Badge>
                  </div>

                  {order.customer_name && (
                    <p className="text-xs text-muted-foreground">
                      Cliente: {decodeHtmlEntities(order.customer_name)}
                    </p>
                  )}

                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {order.omie_ordem_numero && (
                      <span>OP: {order.omie_ordem_numero}</span>
                    )}
                    {order.sales_order_number && (
                      <span>PV: {order.sales_order_number}</span>
                    )}
                    <span>Criado: {format(new Date(order.created_at), "dd/MM/yy HH:mm", { locale: ptBR })}</span>
                  </div>

                  {order.ready_by_date && (
                    <p className="text-xs font-medium text-primary">
                      Prazo: {format(new Date(order.ready_by_date + 'T12:00:00'), "EEEE, dd/MM", { locale: ptBR })}
                    </p>
                  )}

                  {order.completed_at && (
                    <p className="text-xs text-green-600">
                      Finalizado: {format(new Date(order.completed_at), "dd/MM/yy HH:mm", { locale: ptBR })}
                    </p>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2 pt-1">
                    {order.status === 'pending' && (
                      <Button size="sm" variant="outline" onClick={() => handleStartProduction(order.id)}>
                        <Factory className="h-3.5 w-3.5 mr-1" />
                        Iniciar Produção
                      </Button>
                    )}
                    {(order.status === 'pending' || order.status === 'in_progress') && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" variant="default" disabled={finalizingId === order.id}>
                            {finalizingId === order.id ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
                            Finalizar
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Finalizar Ordem de Produção?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Esta ação marcará a ordem como concluída e finalizará no Omie.
                              <br /><br />
                              <strong>{decodeHtmlEntities(order.product_descricao)}</strong> – Qtd: {order.quantidade}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleFinalize(order.id)}>
                              Confirmar
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ProductionOrders;
