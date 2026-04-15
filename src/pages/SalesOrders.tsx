import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2, ShoppingCart, Plus, Package, Trash2, Building2, Wrench, Share2, Printer, Pencil, Search, ChevronLeft } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { toast } from 'sonner';
import { StatusBadgeSimple } from '@/components/StatusBadge';
import { shareOrderViaWhatsApp } from '@/utils/whatsappShare';

type Account = 'oben' | 'colacor' | 'afiacao' | 'all';

interface SalesOrder {
  id: string;
  customer_user_id: string;
  items: Array<{ descricao: string; quantidade: number; valor_unitario: number; valor_total: number }>;
  subtotal: number;
  total: number;
  status: string;
  omie_numero_pedido: string | null;
  omie_pedido_id: number | null;
  created_at: string;
  notes: string | null;
  account?: string;
  _source?: 'sales' | 'afiacao';
}

const statusLabels: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  rascunho: { label: 'Rascunho', variant: 'outline' },
  enviado: { label: 'Enviado ao Omie', variant: 'default' },
  faturado: { label: 'Faturado', variant: 'secondary' },
  cancelado: { label: 'Cancelado', variant: 'destructive' },
  recebido: { label: 'Recebido', variant: 'default' },
  em_analise: { label: 'Em Análise', variant: 'default' },
  em_producao: { label: 'Em Produção', variant: 'default' },
  pronto: { label: 'Pronto', variant: 'secondary' },
  entregue: { label: 'Entregue', variant: 'secondary' },
};

const SalesOrders = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading } = useAuth();
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [accountFilter, setAccountFilter] = useState<Account>('all');
  const [search, setSearch] = useState('');
  const { role } = useAuth();
  useEffect(() => {
    if (!authLoading && role !== null && !isStaff) navigate('/', { replace: true });
  }, [authLoading, role, isStaff, navigate]);

  useEffect(() => {
    if (isStaff) loadOrders();
  }, [isStaff]);

  const loadOrders = async () => {
    try {
      // Load sales orders
      const { data: salesData, error: salesError } = await supabase
        .from('sales_orders')
        .select('*')
        .order('created_at', { ascending: false });

      if (salesError) throw salesError;
      const salesOrders = (salesData || []).map((o: any) => ({ ...o, _source: 'sales' as const })) as SalesOrder[];

      // Load afiação orders
      const { data: afiacaoData, error: afiacaoError } = await supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false });

      if (afiacaoError) throw afiacaoError;
      const afiacaoOrders = (afiacaoData || []).map((o: any) => ({
        id: o.id,
        customer_user_id: o.user_id,
        items: Array.isArray(o.items) ? o.items.map((i: any) => ({
          descricao: i.category || i.name || 'Afiação',
          quantidade: i.quantity || 1,
          valor_unitario: i.unitPrice || 0,
          valor_total: (i.quantity || 1) * (i.unitPrice || 0),
        })) : [],
        subtotal: o.subtotal || o.total || 0,
        total: o.total || 0,
        status: o.status,
        omie_numero_pedido: null,
        omie_pedido_id: null,
        created_at: o.created_at,
        notes: o.notes,
        account: 'afiacao',
        _source: 'afiacao' as const,
      })) as SalesOrder[];

      const allOrders = [...salesOrders, ...afiacaoOrders].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      setOrders(allOrders);

      // Load customer names
      const customerIds = [...new Set(allOrders.map((o) => o.customer_user_id))];
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

  const deleteOrder = async (order: SalesOrder) => {
    try {
      const { error } = await supabase.functions.invoke('omie-vendas-sync', {
        body: {
          action: 'excluir_pedido',
          sales_order_id: order.id,
          omie_pedido_id: order.omie_pedido_id,
        },
      });
      if (error) throw error;
      setOrders((prev) => prev.filter((o) => o.id !== order.id));
      toast.success('Pedido excluído com sucesso');
    } catch (e: any) {
      console.error(e);
      toast.error('Erro ao excluir pedido');
    }
  };

  const handleShareOrder = (order: SalesOrder, customerName: string) => {
    const items = (order.items || []).map(item => ({
      description: item.descricao,
      quantity: item.quantidade,
      unitPrice: item.valor_unitario,
    }));

    const orderNumbers = order.omie_numero_pedido ? [order.omie_numero_pedido.replace(/^0+/, '') || '0'] : [];

    shareOrderViaWhatsApp({
      customerName,
      items,
      total: order.total,
      orderNumbers,
      date: new Date(order.created_at),
    });
  };

  const filteredOrders = useMemo(() => {
    let result = accountFilter === 'all'
      ? orders
      : accountFilter === 'afiacao'
        ? orders.filter(o => o._source === 'afiacao')
        : orders.filter(o => o._source === 'sales' && (o.account || 'oben') === accountFilter);

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(o => {
        const customerName = profiles[o.customer_user_id] || '';
        const pvNumber = o.omie_numero_pedido || '';
        const itemDescs = (o.items || []).map(i => i.descricao).join(' ');
        return (
          customerName.toLowerCase().includes(q) ||
          pvNumber.toLowerCase().includes(q) ||
          itemDescs.toLowerCase().includes(q) ||
          o.total.toFixed(2).includes(q)
        );
      });
    }

    return result;
  }, [orders, accountFilter, search, profiles]);

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center pt-32">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4 pb-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-lg font-semibold">Pedidos</h1>
          <p className="text-xs text-muted-foreground">Gerencie todos os seus pedidos de venda e afiação</p>
        </div>
      </div>

      <div className="flex gap-2">
        <Button onClick={() => navigate('/sales/new')} className="gap-2 flex-1">
          <Plus className="w-4 h-4" />
          Novo Pedido
        </Button>
        <Button variant="outline" onClick={() => navigate('/sales/products')} className="gap-2">
          <Package className="w-4 h-4" />
          Catálogo
        </Button>
        <Button variant="outline" onClick={() => navigate('/sales/print')} className="gap-2">
          <Printer className="w-4 h-4" />
          Imprimir
        </Button>
      </div>

      {/* Account Filter */}
      <Tabs value={accountFilter} onValueChange={(v) => setAccountFilter(v as Account)}>
         <TabsList className="w-full grid grid-cols-4">
          <TabsTrigger value="all">Todos</TabsTrigger>
          <TabsTrigger value="oben" className="gap-1">
            <Building2 className="w-3 h-3" />
            Oben
          </TabsTrigger>
          <TabsTrigger value="colacor" className="gap-1">
            <Building2 className="w-3 h-3" />
            Colacor
          </TabsTrigger>
          <TabsTrigger value="afiacao" className="gap-1">
            <Wrench className="w-3 h-3" />
            Afiação
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Buscar por cliente, nº pedido ou item..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {filteredOrders.length === 0 ? (
        <div className="text-center py-12">
          <ShoppingCart className="w-12 h-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">Nenhum pedido encontrado.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredOrders.map((order) => {
            const isAfiacao = order._source === 'afiacao';
            const status = statusLabels[order.status] || statusLabels.rascunho;
            const totalItems = order.items?.reduce((s, i) => s + (i.quantidade || 0), 0) || 0;
            const orderAccount = isAfiacao ? 'afiacao' : (order.account || 'oben');
            const accountLabel = isAfiacao ? 'Afiação' : orderAccount === 'colacor' ? 'Colacor' : 'Oben';
            return (
              <Card key={`${order._source}-${order.id}`} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => isAfiacao ? navigate(`/orders/${order.id}`) : undefined}>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="font-medium text-sm truncate">
                          {profiles[order.customer_user_id] || 'Cliente'}
                        </p>
                        <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                          {accountLabel}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {format(new Date(order.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                      </p>
                      {order.omie_numero_pedido && (
                        <p className="text-xs text-muted-foreground">
                          PV: {order.omie_numero_pedido.replace(/^0+/, '') || '0'}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0 space-y-1">
                      {isAfiacao ? (
                        <StatusBadgeSimple status={order.status as any} size="sm" />
                      ) : (
                        <Badge variant={status.variant}>{status.label}</Badge>
                      )}
                      <p className="text-sm font-bold">R$ {order.total.toFixed(2)}</p>
                      <p className="text-xs text-muted-foreground">{totalItems} itens</p>
                      <div className="flex gap-1 justify-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleShareOrder(order, profiles[order.customer_user_id] || 'Cliente');
                          }}
                          title="Compartilhar via WhatsApp"
                        >
                          <Share2 className="w-3.5 h-3.5" />
                        </Button>
                        {!isAfiacao && !['cancelado', 'entregue', 'faturado'].includes(order.status) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/sales/edit/${order.id}`);
                            }}
                            title="Editar pedido"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        {!isAfiacao && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={(e) => e.stopPropagation()}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Excluir pedido?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Esta ação não pode ser desfeita. O pedido será removido permanentemente do sistema.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                <AlertDialogAction onClick={() => deleteOrder(order)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                                  Excluir
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </div>
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

export default SalesOrders;
