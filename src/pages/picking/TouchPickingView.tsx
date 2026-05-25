import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ScanBar, type ScanResult } from '@/components/picking/ScanBar';
import { ChevronRight, Package, Monitor } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { setForceFull } from '@/lib/picking/view-pref';
import { useAuth } from '@/contexts/AuthContext';
import { useOfflineMutation } from '@/hooks/useOfflineMutation';
import { confirmPickItem, type ConfirmPickItemVars } from '@/services/picking-confirm';
import { getQueuedByKind, subscribeToOfflineQueue } from '@/lib/offline-queue';
import { applyQueuedPickConfirms } from '@/lib/picking/optimistic-merge';
import { PickItemConfirmCard, type ConfirmPayload } from '@/components/picking/PickItemConfirmCard';

type PickingTaskRow = Pick<Tables<'picking_tasks'>, 'id' | 'sales_order_id' | 'status' | 'created_at'>;
type PickingTaskItemRow = Pick<
  Tables<'picking_task_items'>,
  'id' | 'product_descricao' | 'quantidade' | 'quantidade_separada' | 'status' | 'lote_fefo' | 'lote_separado' | 'separado_at'
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
  const navigate = useNavigate();

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
      <PageSkeleton variant="list" />
    );
  }

  if (activeTaskId) {
    return <ActiveTaskView taskId={activeTaskId} onBack={() => setActiveTaskId(null)} onScan={handleScan} />;
  }

  return (
    <div className="space-y-3">
      <ScanBar onScan={handleScan} placeholder="Bipe um endereço ou código pra começar" />
      <div className="flex justify-end px-1">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs text-muted-foreground"
          onClick={() => { setForceFull(true); navigate('/admin/estoque/picking'); }}
        >
          <Monitor className="h-3.5 w-3.5" />
          Ver versão completa
        </Button>
      </div>
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
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: items, isLoading } = useQuery({
    queryKey: ['touch-pk-items', taskId],
    queryFn: async (): Promise<PickingTaskItemRow[]> => {
      const { data } = await supabase
        .from('picking_task_items')
        .select('id, product_descricao, quantidade, quantidade_separada, status, lote_fefo, lote_separado, separado_at')
        .eq('picking_task_id', taskId)
        .order('id');
      return (data ?? []) as PickingTaskItemRow[];
    },
  });

  const confirmMutation = useOfflineMutation<{ ok: true }, ConfirmPickItemVars>({
    kind: 'picking.confirm-item',
    mutationFn: confirmPickItem,
  });

  // Confirms enfileirados desta task (overlay optimista). Recalcula quando a fila muda:
  // subscribeToOfflineQueue dispara no mount e a cada enqueue/flush.
  const [queuedVars, setQueuedVars] = useState<ConfirmPickItemVars[]>([]);
  useEffect(() => {
    const recompute = () =>
      setQueuedVars(
        getQueuedByKind<ConfirmPickItemVars>('picking.confirm-item')
          .map((q) => q.variables)
          .filter((v) => v.pickingTaskId === taskId),
      );
    return subscribeToOfflineQueue(recompute);
  }, [taskId]);

  // Overlay: mescla confirms enfileirados sobre as linhas do servidor.
  const { items: mergedItems, pendingIds } = useMemo(
    () => applyQueuedPickConfirms(items ?? [], queuedVars),
    [items, queuedVars],
  );

  const total = mergedItems.reduce((s: number, i) => s + (i.quantidade ?? 0), 0);
  const done = mergedItems.reduce((s: number, i) => s + (i.quantidade_separada ?? 0), 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const handleConfirm = async (item: PickingTaskItemRow, payload: ConfirmPayload) => {
    const vars: ConfirmPickItemVars = {
      eventId: crypto.randomUUID(),
      pickingTaskId: taskId,
      pickingTaskItemId: item.id,
      userId: user?.id ?? null,
      quantidade: item.quantidade,
      quantidadeSeparada: payload.quantidadeSeparada,
      loteEsperado: item.lote_fefo,
      loteInformado: payload.loteInformado,
      justificativa: payload.justificativa,
      confirmedAt: new Date().toISOString(),
    };

    // Optimistic instantâneo (feedback <100ms). Reusa o mesmo merge.
    const snapshot = queryClient.getQueryData<PickingTaskItemRow[]>(['touch-pk-items', taskId]);
    queryClient.setQueryData<PickingTaskItemRow[]>(['touch-pk-items', taskId], (old) =>
      old ? applyQueuedPickConfirms(old, [vars]).items : old,
    );

    try {
      const result = await confirmMutation.mutateAsync(vars);
      if (result === null) {
        // Caiu na fila offline — overlay (fila) sustenta o estado.
        toast.info('Salvo offline — sincroniza ao reconectar');
      } else {
        toast.success('Item confirmado');
        queryClient.invalidateQueries({ queryKey: ['touch-pk-items', taskId] });
      }
    } catch {
      // Erro de aplicação (RLS etc.) — rollback do optimistic.
      queryClient.setQueryData(['touch-pk-items', taskId], snapshot);
      toast.error('Falha ao confirmar item');
    }
  };

  if (isLoading) {
    return (
      <PageSkeleton variant="list" />
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
      <div className="space-y-2 px-1">
        {mergedItems.map((it) => (
          <PickItemConfirmCard
            key={it.id}
            item={it}
            pending={pendingIds.has(it.id)}
            onConfirm={(payload) => handleConfirm(it, payload)}
            disabled={confirmMutation.isPending}
          />
        ))}
      </div>
    </div>
  );
}
