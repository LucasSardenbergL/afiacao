import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ArrowLeft, CheckCircle2, AlertTriangle, Package, ScanLine, Keyboard, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { differenceInDays, format, parseISO } from 'date-fns';

interface LoteInfo {
  numero_lote: string;
  data_fabricacao: string | null;
  data_validade: string | null;
  quantidade: number;
  localizacao: string | null;
}

export default function PickingSession() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [loteInput, setLoteInput] = useState('');
  const [showMismatch, setShowMismatch] = useState(false);
  const [justificativa, setJustificativa] = useState('');
  const [showJustificativa, setShowJustificativa] = useState(false);
  const [lotesCache, setLotesCache] = useState<Record<string, { temControleLote: boolean; lotes: LoteInfo[] }>>({});

  // Fetch task with items
  const { data: task, isLoading } = useQuery({
    queryKey: ['picking-task', taskId],
    queryFn: async () => {
      const { data, error } = await (supabase
        .from('picking_tasks' as any)
        .select('*, picking_task_items(*)')
        .eq('id', taskId!)
        .single() as any);
      if (error) throw error;
      return data;
    },
    enabled: !!taskId,
  });

  const items: any[] = task?.picking_task_items || [];
  const activeItem = items.find((i: any) => i.id === activeItemId);

  // Fetch FEFO lots for all items that have omie_codigo_produto
  useEffect(() => {
    if (!items.length) return;
    const fetchLotes = async () => {
      for (const item of items) {
        if (!item.omie_codigo_produto) continue;
        const key = `${task.account}_${item.omie_codigo_produto}`;
        if (lotesCache[key]) continue;

        try {
          const { data, error } = await supabase.functions.invoke('omie-consultar-lotes', {
            body: { produto_omie_id: item.omie_codigo_produto, account: task.account || 'colacor' },
          });
          if (!error && data) {
            setLotesCache(prev => ({ ...prev, [key]: data }));
          }
        } catch (e) {
          console.error('Error fetching lots:', e);
        }
      }
    };
    fetchLotes();
  }, [items.length, task?.account]);

  const getLotesForItem = (item: any) => {
    if (!item.omie_codigo_produto) return null;
    const key = `${task?.account}_${item.omie_codigo_produto}`;
    return lotesCache[key] || null;
  };

  // Update task status
  const updateTaskStatus = useMutation({
    mutationFn: async (status: string) => {
      await (supabase.from('picking_tasks' as any).update({
        status,
        ...(status === 'em_separacao' ? { started_at: new Date().toISOString() } : {}),
        ...(status === 'finalizado' ? { completed_at: new Date().toISOString() } : {}),
      } as any).eq('id', taskId!) as any);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['picking-task', taskId] }),
  });

  // Confirm item with lot
  const confirmItem = useMutation({
    mutationFn: async ({ itemId, lote, isSubstitution, justificativaText }: {
      itemId: string; lote: string; isSubstitution?: boolean; justificativaText?: string;
    }) => {
      // Update item
      await (supabase.from('picking_task_items' as any).update({
        lote_separado: lote,
        quantidade_separada: activeItem?.quantidade || 1,
        status: 'separado',
        separado_at: new Date().toISOString(),
        ...(isSubstitution ? { justificativa_substituicao: justificativaText } : {}),
      } as any).eq('id', itemId) as any);

      // Log event
      const eventType = isSubstitution ? 'lote_substituido' : 'item_separado';
      const lotesInfo = getLotesForItem(activeItem);
      await (supabase.from('picking_events' as any).insert({
        picking_task_id: taskId,
        picking_task_item_id: itemId,
        event_type: eventType,
        user_id: user?.id,
        lote_informado: lote,
        lote_esperado: lotesInfo?.lotes?.[0]?.numero_lote || null,
        justificativa: justificativaText || null,
      } as any) as any);

      // Check if task should be set to em_separacao
      if (task?.status === 'pendente') {
        await updateTaskStatus.mutateAsync('em_separacao');
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['picking-task', taskId] });
      setActiveItemId(null);
      setLoteInput('');
      setShowMismatch(false);
      setShowJustificativa(false);
      setJustificativa('');
      toast.success('Item separado com sucesso!');
    },
  });

  const handleConfirmLote = () => {
    if (!activeItem || !loteInput.trim()) {
      toast.error('Informe o número do lote');
      return;
    }

    const lotesInfo = getLotesForItem(activeItem);
    if (lotesInfo?.temControleLote && lotesInfo.lotes.length > 0) {
      const fefoLote = lotesInfo.lotes[0].numero_lote;
      if (loteInput.trim().toUpperCase() !== fefoLote.toUpperCase()) {
        setShowMismatch(true);
        return;
      }
    }

    confirmItem.mutate({ itemId: activeItem.id, lote: loteInput.trim() });
  };

  const handleSubstitution = () => {
    if (!justificativa.trim()) {
      toast.error('Justificativa obrigatória');
      return;
    }
    confirmItem.mutate({
      itemId: activeItem!.id,
      lote: loteInput.trim(),
      isSubstitution: true,
      justificativaText: justificativa.trim(),
    });
  };

  const handleFinalize = async () => {
    const allDone = items.every((i: any) => i.status === 'separado');
    if (!allDone) {
      toast.error('Todos os itens devem ser separados antes de finalizar');
      return;
    }

    await updateTaskStatus.mutateAsync('finalizado');
    await (supabase.from('picking_events' as any).insert({
      picking_task_id: taskId,
      event_type: 'tarefa_finalizada',
      user_id: user?.id,
    } as any) as any);

    toast.success('Picking finalizado!');
    navigate('/picking');
  };

  if (isLoading) {
    return <div className="p-4"><div className="h-64 bg-muted animate-pulse rounded-lg" /></div>;
  }

  if (!task) {
    return <div className="p-4 text-center text-muted-foreground">Tarefa não encontrada</div>;
  }

  const totalItems = items.length;
  const doneItems = items.filter((i: any) => i.status === 'separado').length;
  const progress = totalItems > 0 ? (doneItems / totalItems) * 100 : 0;

  return (
    <div className="max-w-2xl mx-auto pb-24">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background border-b p-4 space-y-2">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/picking')}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-lg font-bold">Picking #{task.id.slice(0, 8)}</h1>
            <p className="text-sm text-muted-foreground">{doneItems} de {totalItems} itens separados</p>
          </div>
          <Badge variant={task.status === 'finalizado' ? 'default' : 'secondary'}>
            {task.status}
          </Badge>
        </div>
        <Progress value={progress} className="h-2" />
      </div>

      {/* Items */}
      <div className="p-4 space-y-3">
        {items.map((item: any) => {
          const lotesInfo = getLotesForItem(item);
          const fefoLote = lotesInfo?.temControleLote ? lotesInfo.lotes[0] : null;
          const isSeparado = item.status === 'separado';

          let diasVencimento: number | null = null;
          if (fefoLote?.data_validade) {
            try {
              diasVencimento = differenceInDays(parseISO(fefoLote.data_validade), new Date());
            } catch { /* ignore */ }
          }

          return (
            <Card
              key={item.id}
              className={`transition-all ${isSeparado ? 'opacity-60 border-green-300 dark:border-green-700' : 'cursor-pointer hover:shadow-md'}`}
              onClick={() => !isSeparado && task.status !== 'finalizado' && setActiveItemId(item.id)}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-1">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{item.product_descricao || 'Produto'}</p>
                    <p className="text-xs text-muted-foreground">{item.product_codigo}</p>
                  </div>
                  {isSeparado ? (
                    <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
                  ) : (
                    <span className="text-sm font-bold">{item.quantidade} un</span>
                  )}
                </div>

                {item.localizacao && (
                  <p className="text-xs text-muted-foreground mb-1">📍 {item.localizacao}</p>
                )}

                {/* FEFO Lot info */}
                {lotesInfo?.temControleLote && fefoLote && !isSeparado && (
                  <div className="mt-2 p-2 rounded bg-accent/50 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">Lote FEFO: {fefoLote.numero_lote}</span>
                      {diasVencimento !== null && diasVencimento < 60 && (
                        <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                          Vence em {diasVencimento}d
                        </Badge>
                      )}
                    </div>
                    {fefoLote.data_validade && (
                      <p className="text-[11px] text-muted-foreground">
                        Validade: {format(parseISO(fefoLote.data_validade), 'dd/MM/yyyy')}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      Estoque: {fefoLote.quantidade} un
                      {fefoLote.localizacao ? ` — ${fefoLote.localizacao}` : ''}
                    </p>
                  </div>
                )}

                {/* If no lot control */}
                {lotesInfo && !lotesInfo.temControleLote && !isSeparado && (
                  <p className="text-[11px] text-muted-foreground mt-1 italic">Sem controle de lote</p>
                )}

                {/* Separated info */}
                {isSeparado && (
                  <div className="mt-1 text-xs text-green-700 dark:text-green-400">
                    ✓ Lote: {item.lote_separado || 'N/A'}
                    {item.justificativa_substituicao && (
                      <span className="ml-2 text-amber-600">⚠ Substituído</span>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Finalize button */}
      {task.status !== 'finalizado' && doneItems === totalItems && totalItems > 0 && (
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-background border-t">
          <Button onClick={handleFinalize} className="w-full h-14 text-lg bg-green-600 hover:bg-green-700">
            <CheckCircle2 className="w-5 h-5 mr-2" />
            Finalizar Picking
          </Button>
        </div>
      )}

      {/* Item scanning sheet */}
      <Sheet open={!!activeItemId} onOpenChange={(open) => {
        if (!open) {
          setActiveItemId(null);
          setLoteInput('');
        }
      }}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
          {activeItem && (() => {
            const lotesInfo = getLotesForItem(activeItem);
            const fefoLote = lotesInfo?.temControleLote ? lotesInfo.lotes[0] : null;
            const requiresLot = lotesInfo?.temControleLote;

            return (
              <div className="space-y-4 pb-4">
                <SheetHeader>
                  <SheetTitle className="text-left">{activeItem.product_descricao}</SheetTitle>
                </SheetHeader>

                <div className="text-center py-2">
                  <p className="text-4xl font-bold">{activeItem.quantidade} un</p>
                  <p className="text-sm text-muted-foreground">a separar</p>
                </div>

                {activeItem.localizacao && (
                  <div className="text-center text-sm bg-accent/50 rounded p-2">
                    📍 Localização: <strong>{activeItem.localizacao}</strong>
                  </div>
                )}

                {/* FEFO info */}
                {fefoLote && (
                  <Card className="border-blue-200 dark:border-blue-800">
                    <CardContent className="p-3 space-y-1">
                      <p className="text-sm font-medium">🏷️ Lote FEFO: <span className="text-blue-600 dark:text-blue-400 font-bold">{fefoLote.numero_lote}</span></p>
                      {fefoLote.data_validade && (
                        <p className="text-xs text-muted-foreground">
                          Validade: {format(parseISO(fefoLote.data_validade), 'dd/MM/yyyy')}
                          {(() => {
                            const days = differenceInDays(parseISO(fefoLote.data_validade), new Date());
                            return days < 60 ? <Badge variant="destructive" className="ml-2 text-[10px]">Vence em {days}d</Badge> : null;
                          })()}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">Estoque: {fefoLote.quantidade} un</p>
                    </CardContent>
                  </Card>
                )}

                {/* Lot input */}
                {requiresLot ? (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Informe o lote da embalagem</label>
                    <div className="flex gap-2">
                      <Input
                        value={loteInput}
                        onChange={e => setLoteInput(e.target.value.toUpperCase())}
                        placeholder="Digite ou escaneie o lote"
                        className="text-lg h-12 font-mono"
                        autoFocus
                      />
                    </div>
                    <Button onClick={handleConfirmLote} className="w-full h-12" disabled={!loteInput.trim()}>
                      <CheckCircle2 className="w-4 h-4 mr-2" />
                      Confirmar Lote
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground italic">Produto sem controle de lote</p>
                    <Button
                      onClick={() => confirmItem.mutate({ itemId: activeItem.id, lote: 'SEM_LOTE' })}
                      className="w-full h-12"
                    >
                      <CheckCircle2 className="w-4 h-4 mr-2" />
                      Confirmar Separação
                    </Button>
                  </div>
                )}

                {/* Other available lots */}
                {lotesInfo?.lotes && lotesInfo.lotes.length > 1 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Outros lotes disponíveis:</p>
                    {lotesInfo.lotes.slice(1, 5).map((l, idx) => (
                      <div key={idx} className="text-xs flex justify-between bg-muted/50 rounded px-2 py-1">
                        <span className="font-mono">{l.numero_lote}</span>
                        <span>{l.data_validade ? format(parseISO(l.data_validade), 'dd/MM/yy') : '—'} | {l.quantidade} un</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </SheetContent>
      </Sheet>

      {/* Mismatch dialog */}
      <Dialog open={showMismatch} onOpenChange={setShowMismatch}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-5 h-5" />
              Lote diferente do FEFO
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm">
              O lote <strong className="font-mono">{loteInput}</strong> informado não é o lote FEFO indicado.
            </p>
            {(() => {
              const lotesInfo = getLotesForItem(activeItem);
              const fefoLote = lotesInfo?.lotes?.[0];
              return fefoLote ? (
                <div className="bg-blue-50 dark:bg-blue-950 rounded p-3 text-sm">
                  O lote <strong className="font-mono">{fefoLote.numero_lote}</strong> vence antes
                  {fefoLote.data_validade && ` (${format(parseISO(fefoLote.data_validade), 'dd/MM/yyyy')})`} e deve sair primeiro.
                </div>
              ) : null;
            })()}
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button variant="outline" className="w-full" onClick={() => { setShowMismatch(false); setLoteInput(''); }}>
              Pegar o lote correto
            </Button>
            <Button variant="secondary" className="w-full" onClick={() => { setShowMismatch(false); setShowJustificativa(true); }}>
              Justificar substituição
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Justification dialog */}
      <Dialog open={showJustificativa} onOpenChange={setShowJustificativa}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Justificar Substituição de Lote</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Explique por que o lote FEFO não foi utilizado (ex: "lote danificado", "não encontrado na prateleira").
            </p>
            <Textarea
              value={justificativa}
              onChange={e => setJustificativa(e.target.value)}
              placeholder="Motivo da substituição..."
              rows={3}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button onClick={handleSubstitution} disabled={!justificativa.trim()}>
              Confirmar com Justificativa
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
