import { useNavigate } from 'react-router-dom';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Package, Loader2, ChevronRight, Clock, Timer, ArrowRight, GripVertical } from 'lucide-react';
import { formatDistanceToNow, differenceInHours } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';

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

interface KanbanBoardProps {
  orders: OrderWithProfile[];
  onStatusChange: (orderId: string, status: string) => Promise<void>;
  updatingOrder: string | null;
}

// Kanban column definitions
const KANBAN_COLUMNS = [
  {
    id: 'em_posse',
    title: 'Em Nossa Posse',
    subtitle: 'Ferramentas recebidas',
    statuses: ['pedido_recebido', 'aguardando_coleta', 'em_triagem', 'orcamento_enviado', 'aprovado'],
    bgClass: 'bg-blue-50 dark:bg-blue-950/30',
    borderClass: 'border-blue-200 dark:border-blue-800',
    badgeClass: 'bg-blue-500',
    nextTargetStatus: 'em_afiacao',
    nextLabel: 'Enviar para Afiação',
    dropTargetStatus: 'em_triagem', // status when dropped into this column
  },
  {
    id: 'em_afiacao',
    title: 'Em Afiação',
    subtitle: 'Sendo processadas',
    statuses: ['em_afiacao', 'controle_qualidade'],
    bgClass: 'bg-orange-50 dark:bg-orange-950/30',
    borderClass: 'border-orange-200 dark:border-orange-800',
    badgeClass: 'bg-primary',
    nextTargetStatus: 'pronto_entrega',
    nextLabel: 'Marcar como Afiada',
    dropTargetStatus: 'em_afiacao',
  },
  {
    id: 'afiada',
    title: 'Afiada',
    subtitle: 'Prontas para entrega',
    statuses: ['pronto_entrega', 'em_rota', 'entregue'],
    bgClass: 'bg-emerald-50 dark:bg-emerald-950/30',
    borderClass: 'border-emerald-200 dark:border-emerald-800',
    badgeClass: 'bg-emerald-500',
    nextTargetStatus: 'entregue',
    nextLabel: 'Marcar Entregue',
    dropTargetStatus: 'pronto_entrega',
  },
];

const STATUS_LABELS: Record<string, string> = {
  pedido_recebido: 'Recebido',
  aguardando_coleta: 'Aguardando Coleta',
  em_triagem: 'Em Triagem',
  orcamento_enviado: 'Orçamento Enviado',
  aprovado: 'Aprovado',
  em_afiacao: 'Em Afiação',
  controle_qualidade: 'Controle Qualidade',
  pronto_entrega: 'Pronto p/ Entrega',
  em_rota: 'Em Rota',
  entregue: 'Entregue',
};

function getTimeInStage(order: OrderWithProfile): string {
  const updatedAt = new Date(order.updated_at);
  return formatDistanceToNow(updatedAt, { locale: ptBR, addSuffix: false });
}

function getTotalElapsed(order: OrderWithProfile): string {
  const createdAt = new Date(order.created_at);
  return formatDistanceToNow(createdAt, { locale: ptBR, addSuffix: false });
}

function getUrgencyLevel(order: OrderWithProfile): 'normal' | 'warning' | 'urgent' {
  const hours = differenceInHours(new Date(), new Date(order.updated_at));
  if (hours >= 48) return 'urgent';
  if (hours >= 24) return 'warning';
  return 'normal';
}

function findColumnForOrder(order: OrderWithProfile) {
  return KANBAN_COLUMNS.find((col) => col.statuses.includes(order.status));
}

export function KanbanBoard({ orders, onStatusChange, updatingOrder }: KanbanBoardProps) {
  const navigate = useNavigate();

  const handleDragEnd = (result: DropResult) => {
    const { draggableId, destination, source } = result;
    if (!destination || destination.droppableId === source.droppableId) return;

    const targetColumn = KANBAN_COLUMNS.find((col) => col.id === destination.droppableId);
    if (!targetColumn) return;

    // Don't allow dropping if already updating
    if (updatingOrder) return;

    onStatusChange(draggableId, targetColumn.dropTargetStatus);
  };

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="flex gap-3 overflow-x-auto no-scrollbar pb-4 -mx-4 px-4 snap-x snap-mandatory">
        {KANBAN_COLUMNS.map((column) => {
          const columnOrders = orders.filter((o) =>
            column.statuses.includes(o.status)
          );

          return (
            <Droppable droppableId={column.id} key={column.id}>
              {(provided, snapshot) => (
                <div
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className={cn(
                    'flex-shrink-0 w-[85vw] max-w-[340px] rounded-2xl border p-3 snap-center transition-colors',
                    column.bgClass,
                    column.borderClass,
                    snapshot.isDraggingOver && 'ring-2 ring-primary/40 border-primary/50'
                  )}
                >
                  {/* Column Header */}
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h3 className="font-display font-bold text-sm text-foreground">
                        {column.title}
                      </h3>
                      <p className="text-xs text-muted-foreground">{column.subtitle}</p>
                    </div>
                    <Badge
                      variant="secondary"
                      className={cn('text-white text-xs font-bold', column.badgeClass)}
                    >
                      {columnOrders.length}
                    </Badge>
                  </div>

                  {/* Column Orders */}
                  <div className="space-y-2 max-h-[60vh] overflow-y-auto no-scrollbar min-h-[80px]">
                    {columnOrders.length > 0 ? (
                      columnOrders.map((order, index) => (
                        <Draggable
                          key={order.id}
                          draggableId={order.id}
                          index={index}
                          isDragDisabled={order.status === 'entregue' || updatingOrder === order.id}
                        >
                          {(dragProvided, dragSnapshot) => (
                            <div
                              ref={dragProvided.innerRef}
                              {...dragProvided.draggableProps}
                              className={cn(
                                dragSnapshot.isDragging && 'opacity-90 rotate-2 scale-105 z-50'
                              )}
                            >
                              <KanbanCard
                                order={order}
                                column={column}
                                updatingOrder={updatingOrder}
                                onStatusChange={onStatusChange}
                                onNavigate={() => navigate(`/admin/orders/${order.id}`)}
                                dragHandleProps={dragProvided.dragHandleProps}
                                isDragging={dragSnapshot.isDragging}
                              />
                            </div>
                          )}
                        </Draggable>
                      ))
                    ) : (
                      <div className="text-center py-8 text-muted-foreground/60">
                        <Package className="w-8 h-8 mx-auto mb-2 opacity-40" />
                        <p className="text-xs">Nenhum pedido</p>
                      </div>
                    )}
                    {provided.placeholder}
                  </div>
                </div>
              )}
            </Droppable>
          );
        })}
      </div>
    </DragDropContext>
  );
}

interface KanbanCardProps {
  order: OrderWithProfile;
  column: typeof KANBAN_COLUMNS[number];
  updatingOrder: string | null;
  onStatusChange: (orderId: string, status: string) => Promise<void>;
  onNavigate: () => void;
  dragHandleProps: any;
  isDragging: boolean;
}

function KanbanCard({ order, column, updatingOrder, onStatusChange, onNavigate, dragHandleProps, isDragging }: KanbanCardProps) {
  const urgency = getUrgencyLevel(order);
  const items = Array.isArray(order.items) ? order.items : [];
  const isCompleted = order.status === 'entregue';

  return (
    <Card
      className={cn(
        'cursor-pointer hover:shadow-medium transition-all border',
        urgency === 'urgent' && 'border-destructive/50 shadow-sm',
        urgency === 'warning' && 'border-amber-300 dark:border-amber-700',
        isCompleted && 'opacity-60',
        isDragging && 'shadow-strong border-primary'
      )}
      onClick={onNavigate}
    >
      <CardContent className="p-3">
        {/* Drag handle + Customer name */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5 min-w-0">
            {!isCompleted && (
              <div
                {...dragHandleProps}
                className="touch-none flex-shrink-0 text-muted-foreground/40 hover:text-muted-foreground cursor-grab active:cursor-grabbing"
                onClick={(e) => e.stopPropagation()}
              >
                <GripVertical className="w-4 h-4" />
              </div>
            )}
            <p className="font-semibold text-sm text-foreground truncate">
              {order.profiles?.name || 'Cliente'}
            </p>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        </div>

        {/* Sub-status label */}
        <Badge variant="outline" className="text-[10px] mb-2 font-normal">
          {STATUS_LABELS[order.status] || order.status}
        </Badge>

        {/* Items count */}
        <p className="text-xs text-muted-foreground mb-2">
          🔧 {items.length} {items.length === 1 ? 'item' : 'itens'}
        </p>

        {/* Time tracking */}
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground mb-2">
          <span className="flex items-center gap-1">
            <Timer className="w-3 h-3" />
            Nesta etapa: {getTimeInStage(order)}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-3">
          <Clock className="w-3 h-3" />
          Total: {getTotalElapsed(order)}
        </div>

        {/* Urgency indicator */}
        {urgency !== 'normal' && (
          <div className={cn(
            'text-[10px] font-medium px-2 py-0.5 rounded-full mb-2 inline-block',
            urgency === 'urgent' ? 'bg-destructive/10 text-destructive' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
          )}>
            {urgency === 'urgent' ? '⚠️ Parado há mais de 48h' : '⏰ Parado há mais de 24h'}
          </div>
        )}

        {/* Action button */}
        {!isCompleted && (
          <Button
            size="sm"
            variant="outline"
            className="w-full text-xs h-7"
            disabled={updatingOrder === order.id}
            onClick={(e) => {
              e.stopPropagation();
              onStatusChange(order.id, column.nextTargetStatus);
            }}
          >
            {updatingOrder === order.id ? (
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <ArrowRight className="w-3 h-3 mr-1" />
            )}
            {column.nextLabel}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
