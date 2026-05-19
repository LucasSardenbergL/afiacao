import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScanBar, type ScanResult } from '@/components/picking/ScanBar';
import { Loader2, ChevronRight, Check, AlertTriangle, Package } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

type PickingTaskRow = Pick<Tables<'picking_tasks'>, 'id' | 'sales_order_id' | 'status' | 'created_at'>;
type PickingTaskItemRow = Pick<
  Tables<'picking_task_items'>,
  'id' | 'product_descricao' | 'quantidade' | 'quantidade_separada' | 'status' | 'lote_fefo' | 'lote_separado'
>;

/**
 * Visão mobile dedicada do picking — separador no chão, com luva, sinal ruim.
 *
 * Hoje (scaffold v1): lista as tasks abertas como cards verticais grandes (h-20+),
 * scan-first input no topo, foco em 1 task por vez.
 *
 * Próximas iterações:
 *  - Swipe-to-advance entre itens da task
 *  - Optimistic UI no confirmar item (usa useOptimisticMutation já existente)
 *  - Integração com offline-queue (já existe scaffold em src/lib/offline-queue.ts)
 *  - Layout em "kiosk mode" (sem app shell, fullscreen)
 *
 * Para entrar em uso real, falta:
 *  - Decisão de produto sobre dual-view (auto-detect mobile + pointer:coarse vs rota dedicada)
 *  - Validação no chão com separador real (touch targets, fontes, contraste sob luz variável)
 */

const ACCOUNT_DEFAULT = 'oben'; // TODO(produto): puxar do CompanyContext quando picking suportar multi-empresa

export default function TouchPickingView() {
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  const { data: tasks, isLoading } = useQuery({
    queryKey: ['touch-pk-tasks', ACCOUNT_DEFAULT],
    queryFn: async (): Promise<PickingTaskRow[]> => {
      const { data } = await supabase
        .from('picking_tasks')
        .select('id, sales_order_id, status, created_at')
        .eq('account', ACCOUNT_DEFAULT)
        .in('status', ['pendente', 'em_andamento'])
        .order('created_at', { ascending: true })
        .limit(20);
      return (data ?? []) as PickingTaskRow[];
    },
    refetchInterval: 30000,
  });

  const handleScan = (result: ScanResult) => {
    // v1: feedback. Próxima iteração: navegar para o item correspondente da task ativa.
    toast.success(
      result.kind === 'address' ? `Endereço: ${result.raw}` : `Produto: ${result.raw}`,
      { duration: 1500 },
    );
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-20 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (activeTaskId) {
    return <ActiveTaskView taskId={activeTaskId} onBack={() => setActiveTaskId(null)} onScan={handleScan} />;
  }

  return (
    <div className="space-y-3">
      <ScanBar onScan={handleScan} placeholder="Bipe um endereço ou código pra começar" />
      <div className="px-1 pt-2">
        <h2 className="text-base font-semibold mb-2">Tasks abertas</h2>
        {(tasks ?? []).length === 0 ? (
          <div className="text-center py-12 text-sm text-muted-foreground">
            <Package className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
            Nenhuma task pendente. Bom trabalho!
          </div>
        ) : (
          <ul className="space-y-2">
            {(tasks ?? []).map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setActiveTaskId(t.id)}
                  className={cn(
                    'w-full flex items-center gap-3 p-4 rounded-lg bg-card border border-border',
                    'hover:bg-muted active:bg-muted/70 transition-colors min-h-[72px]',
                  )}
                >
                  <Package className="w-5 h-5 text-primary shrink-0" />
                  <div className="flex-1 min-w-0 text-left">
                    <p className="font-mono text-sm font-medium truncate">Task {t.id.slice(0, 8)}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      Pedido {t.sales_order_id?.slice(0, 8) ?? '—'} · {t.status}
                    </p>
                  </div>
                  <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ActiveTaskView({
  taskId,
  onBack,
  onScan,
}: {
  taskId: string;
  onBack: () => void;
  onScan: (r: ScanResult) => void;
}) {
  const { data: items, isLoading } = useQuery({
    queryKey: ['touch-pk-items', taskId],
    queryFn: async (): Promise<PickingTaskItemRow[]> => {
      const { data } = await supabase
        .from('picking_task_items')
        .select('id, product_descricao, quantidade, quantidade_separada, status, lote_fefo, lote_separado')
        .eq('picking_task_id', taskId)
        .order('id');
      return (data ?? []) as PickingTaskItemRow[];
    },
  });

  const total = (items ?? []).reduce((s: number, i) => s + (i.quantidade ?? 0), 0);
  const done = (items ?? []).reduce((s: number, i) => s + (i.quantidade_separada ?? 0), 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  if (isLoading) {
    return (
      <div className="flex justify-center py-20 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ScanBar onScan={onScan} placeholder="Bipe o endereço ou código do produto" />
      <div className="px-1">
        <Button size="touch" variant="outline" onClick={onBack} className="mb-3">
          ← Voltar
        </Button>
        <div className="space-y-1">
          <div className="flex justify-between text-sm">
            <span className="font-medium">Task {taskId.slice(0, 8)}</span>
            <span className="text-muted-foreground">{done}/{total} ({pct}%)</span>
          </div>
          <Progress value={pct} className="h-3" />
        </div>
      </div>
      <ul className="space-y-2 px-1">
        {(items ?? []).map((it) => {
          const ok = it.status === 'concluido' || (it.quantidade_separada ?? 0) >= it.quantidade;
          const divergente = it.lote_separado && it.lote_fefo && it.lote_separado !== it.lote_fefo;
          return (
            <Card key={it.id} className={cn(ok && 'opacity-50')}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-base font-medium leading-snug">{it.product_descricao}</p>
                  {ok && <Check className="w-5 h-5 text-status-success shrink-0" />}
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Badge variant="outline" className="text-xs">
                    {it.quantidade_separada ?? 0} de {it.quantidade}
                  </Badge>
                  {it.lote_fefo && (
                    <Badge variant="outline" className="text-xs font-mono">
                      FEFO: {it.lote_fefo}
                    </Badge>
                  )}
                  {divergente && (
                    <Badge variant="outline" className="text-xs status-pending gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      Lote divergente
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </ul>
    </div>
  );
}
