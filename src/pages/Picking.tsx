import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Package, Plus, Clock, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';

const statusConfig: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  pendente: { label: 'Pendente', color: 'bg-muted text-muted-foreground', icon: Clock },
  em_separacao: { label: 'Em Separação', color: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200', icon: Package },
  finalizado: { label: 'Finalizado', color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200', icon: CheckCircle2 },
  divergencia: { label: 'Divergência', color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200', icon: AlertTriangle },
};

export default function Picking() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showCreate, setShowCreate] = useState(false);

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ['picking-tasks', statusFilter],
    queryFn: async () => {
      let q = (supabase.from('picking_tasks' as any).select('*, picking_task_items(*)') as any);
      if (statusFilter !== 'all') q = q.eq('status', statusFilter);
      q = q.order('created_at', { ascending: false });
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },
  });

  const { data: pendingOrders = [] } = useQuery({
    queryKey: ['orders-for-picking'],
    queryFn: async () => {
      const { data } = await supabase
        .from('sales_orders')
        .select('id, omie_numero_pedido, customer_address, items, total, account, created_at')
        .in('status', ['aprovado', 'em_separacao'])
        .order('created_at', { ascending: true })
        .limit(50);
      return data || [];
    },
  });

  const handleCreateTask = async (orderId: string) => {
    const order = pendingOrders.find((o: any) => o.id === orderId);
    if (!order) return;

    const items = (order as any).items || [];
    const { data: task, error } = await (supabase.from('picking_tasks' as any).insert({
      sales_order_id: orderId,
      account: (order as any).account || 'colacor',
      status: 'pendente',
      assigned_to: user?.id,
    } as any).select().single() as any);

    if (error) {
      toast.error('Erro ao criar tarefa: ' + error.message);
      return;
    }

    // Create items
    const taskItems = items.map((item: any) => ({
      picking_task_id: task.id,
      omie_codigo_produto: item.omie_codigo_produto || null,
      product_codigo: item.codigo || item.product_codigo || '',
      product_descricao: item.descricao || item.product_descricao || item.description || '',
      quantidade: item.quantity || item.quantidade || 1,
      localizacao: item.localizacao || null,
    }));

    if (taskItems.length > 0) {
      await (supabase.from('picking_task_items' as any).insert(taskItems) as any);
    }

    toast.success('Tarefa de picking criada!');
    setShowCreate(false);
    navigate(`/picking/${task.id}`);
  };

  const getProgress = (task: any) => {
    const items = task.picking_task_items || [];
    if (items.length === 0) return 0;
    const done = items.filter((i: any) => i.status === 'separado').length;
    return Math.round((done / items.length) * 100);
  };

  return (
    <div className="p-4 space-y-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Picking</h1>
          <p className="text-sm text-muted-foreground">Separação de pedidos</p>
        </div>
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="w-4 h-4 mr-1" />Nova Tarefa</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Criar Tarefa de Picking</DialogTitle></DialogHeader>
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {pendingOrders.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhum pedido pendente.</p>
              ) : (
                pendingOrders.map((order: any) => (
                  <Card key={order.id} className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => handleCreateTask(order.id)}>
                    <CardContent className="p-3">
                      <div className="flex justify-between items-center">
                        <div>
                          <p className="font-medium">Pedido #{order.omie_numero_pedido || order.id.slice(0, 8)}</p>
                          <p className="text-xs text-muted-foreground">{(order.items as any[])?.length || 0} itens — R$ {Number(order.total).toFixed(2)}</p>
                        </div>
                        <Badge variant="secondary">{order.account}</Badge>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <Select value={statusFilter} onValueChange={setStatusFilter}>
        <SelectTrigger className="w-48">
          <SelectValue placeholder="Filtrar por status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todos</SelectItem>
          <SelectItem value="pendente">Pendente</SelectItem>
          <SelectItem value="em_separacao">Em Separação</SelectItem>
          <SelectItem value="finalizado">Finalizado</SelectItem>
          <SelectItem value="divergencia">Divergência</SelectItem>
        </SelectContent>
      </Select>

      {/* Task List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
        </div>
      ) : tasks.length === 0 ? (
        <div className="text-center py-12">
          <Package className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">Nenhuma tarefa de picking</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((task: any) => {
            const cfg = statusConfig[task.status] || statusConfig.pendente;
            const StatusIcon = cfg.icon;
            const progress = getProgress(task);
            const itemCount = task.picking_task_items?.length || 0;
            const doneCount = task.picking_task_items?.filter((i: any) => i.status === 'separado').length || 0;

            return (
              <Card
                key={task.id}
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => navigate(`/picking/${task.id}`)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <StatusIcon className="w-5 h-5" />
                      <span className="font-medium">Tarefa #{task.id.slice(0, 8)}</span>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>
                      {cfg.label}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">
                    {doneCount} de {itemCount} itens separados
                  </p>
                  <Progress value={progress} className="h-2" />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
