import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertTriangle, Ban, CheckCircle2, Clock, ExternalLink, Eye, Loader2, PlayCircle, RefreshCw, Trash2, XCircle } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { logger } from '@/lib/logger';

type Status =
  | 'pendente_aprovacao'
  | 'aprovado_aguardando_disparo'
  | 'bloqueado_guardrail'
  | 'disparado'
  | 'cancelado'
  | 'cancelado_humano'
  | 'expirado_sem_aprovacao'
  | string;

interface PedidoSugerido {
  id: number;
  empresa: string;
  fornecedor_nome: string;
  grupo_codigo: string | null;
  data_ciclo: string;
  horario_geracao: string | null;
  horario_corte_planejado: string | null;
  horario_disparo_real: string | null;
  valor_total: number;
  num_skus: number;
  pedido_anterior_valor: number | null;
  delta_vs_anterior_perc: number | null;
  status: Status;
  mensagem_bloqueio: string | null;
  omie_pedido_compra_numero: string | null;
  aprovado_em: string | null;
  aprovado_por: string | null;
}

interface PedidoItem {
  id: number;
  pedido_id: number;
  sku_codigo_omie: string;
  sku_descricao: string | null;
  estoque_atual: number | null;
  ponto_pedido: number | null;
  estoque_maximo: number | null;
  qtde_sugerida: number;
  qtde_final: number | null;
  preco_unitario: number | null;
  valor_linha: number | null;
  primeira_compra: boolean | null;
  ajustado_humano: boolean | null;
}

const EMPRESA = 'OBEN';

const statusMeta: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; className?: string }> = {
  pendente_aprovacao: { label: 'Pendente', variant: 'secondary', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30' },
  aprovado_aguardando_disparo: { label: 'Aprovado', variant: 'secondary', className: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30' },
  bloqueado_guardrail: { label: 'Bloqueado', variant: 'destructive' },
  disparado: { label: 'Disparado', variant: 'secondary', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30' },
  cancelado: { label: 'Cancelado', variant: 'outline' },
  cancelado_humano: { label: 'Cancelado (vazio)', variant: 'outline' },
  expirado_sem_aprovacao: { label: 'Expirado sem aprovação', variant: 'secondary', className: 'bg-muted text-muted-foreground border-border' },
};

function formatBRL(v: number | null | undefined) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v ?? 0));
}

function formatTime(iso: string | null) {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'HH:mm');
  } catch {
    return '—';
  }
}

function StatusBadge({ status }: { status: Status }) {
  const meta = statusMeta[status] ?? { label: status, variant: 'outline' as const };
  return (
    <Badge variant={meta.variant} className={meta.className}>
      {meta.label}
    </Badge>
  );
}

function CycleIndicator({ now }: { now: Date }) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const overrideUntil = 9 * 60 + 30; // 09:30
  const cutoff = 10 * 60; // 10:00

  if (minutes < overrideUntil) {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 text-sm">
        <Clock className="w-4 h-4" />
        Janela de override aberta até 09:30
      </div>
    );
  }
  if (minutes < cutoff) {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30 text-sm">
        <PlayCircle className="w-4 h-4" />
        Disparando em breve
      </div>
    );
  }
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted text-muted-foreground border text-sm">
      <CheckCircle2 className="w-4 h-4" />
      Ciclo finalizado
    </div>
  );
}

/* ─── Detalhes Modal ─── */
function DetalhesModal({
  pedido,
  open,
  onOpenChange,
  onApproved,
}: {
  pedido: PedidoSugerido | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onApproved: () => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Record<number, number>>({});
  const [obs, setObs] = useState('');
  const [removerItem, setRemoverItem] = useState<PedidoItem | null>(null);
  const [descontinuarItem, setDescontinuarItem] = useState<PedidoItem | null>(null);

  const { data: itens, isLoading } = useQuery({
    queryKey: ['pedido-itens', pedido?.id],
    queryFn: async () => {
      if (!pedido) return [] as PedidoItem[];
      const { data, error } = await supabase
        .from('pedido_compra_item')
        .select('*')
        .eq('pedido_id', pedido.id)
        .order('id', { ascending: true });
      if (error) throw error;
      return (data ?? []) as PedidoItem[];
    },
    enabled: !!pedido && open,
  });

  useEffect(() => {
    if (!open) {
      setEdits({});
      setObs('');
    }
  }, [open]);

  const linhas = useMemo(() => {
    return (itens ?? []).map((it) => {
      const qtd = edits[it.id] ?? Number(it.qtde_final ?? it.qtde_sugerida);
      const preco = Number(it.preco_unitario ?? 0);
      return { ...it, _qtd: qtd, _valor: qtd * preco };
    });
  }, [itens, edits]);

  const totalAtual = useMemo(
    () => linhas.reduce((acc, l) => acc + l._valor, 0),
    [linhas],
  );

  const salvarMutation = useMutation({
    mutationFn: async () => {
      if (!pedido) return;
      const updates = Object.entries(edits);
      for (const [itemId, qtd] of updates) {
        const item = (itens ?? []).find((i) => i.id === Number(itemId));
        const preco = Number(item?.preco_unitario ?? 0);
        const { error } = await supabase
          .from('pedido_compra_item')
          .update({
            qtde_final: qtd,
            valor_linha: qtd * preco,
            ajustado_humano: true,
          })
          .eq('id', Number(itemId));
        if (error) throw error;
      }
      const novoTotal = linhas.reduce((acc, l) => acc + l._valor, 0);
      const { error: errPed } = await supabase
        .from('pedido_compra_sugerido')
        .update({ valor_total: novoTotal, atualizado_em: new Date().toISOString() })
        .eq('id', pedido.id);
      if (errPed) throw errPed;
    },
    onSuccess: () => {
      toast.success('Ajustes salvos');
      queryClient.invalidateQueries({ queryKey: ['pedido-itens', pedido?.id] });
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
      setEdits({});
    },
    onError: (e: Error) => {
      logger.error('Erro ao salvar ajustes', { error: e });
      toast.error(`Erro ao salvar: ${e.message}`);
    },
  });

  const aprovarMutation = useMutation({
    mutationFn: async () => {
      if (!pedido) return;
      // salvar ajustes primeiro se houver
      if (Object.keys(edits).length > 0) {
        await salvarMutation.mutateAsync();
      }
      const { data, error } = await supabase.rpc('aprovar_pedido_sugerido', {
        p_pedido_id: pedido.id,
        p_usuario: user?.email ?? 'sistema',
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      const horario = pedido?.horario_corte_planejado ? formatTime(pedido.horario_corte_planejado) : 'horário planejado';
      toast.success(`Pedido aprovado. Será disparado às ${horario}.`);
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
      onApproved();
      onOpenChange(false);
    },
    onError: (e: Error) => {
      logger.error('Erro ao aprovar pedido', { error: e });
      toast.error(`Erro ao aprovar: ${e.message}`);
    },
  });

  // Recalcula valor total e status do pedido após remoção de item
  const recalcularPedido = async () => {
    if (!pedido) return;
    const { data: restantes, error } = await supabase
      .from('pedido_compra_item')
      .select('id, qtde_final, qtde_sugerida, preco_unitario')
      .eq('pedido_id', pedido.id);
    if (error) throw error;

    const itensRest = restantes ?? [];
    const novoTotal = itensRest.reduce((acc, it) => {
      const q = Number(it.qtde_final ?? it.qtde_sugerida ?? 0);
      const p = Number(it.preco_unitario ?? 0);
      return acc + q * p;
    }, 0);

    const updates: Record<string, unknown> = {
      valor_total: novoTotal,
      num_skus: itensRest.length,
      atualizado_em: new Date().toISOString(),
    };
    if (itensRest.length === 0) {
      updates.status = 'cancelado_humano';
      updates.cancelado_por = user?.email ?? 'sistema';
      updates.cancelado_em = new Date().toISOString();
      updates.justificativa_cancelamento = 'Todos os itens foram removidos manualmente';
    }
    const { error: errPed } = await supabase
      .from('pedido_compra_sugerido')
      .update(updates)
      .eq('id', pedido.id);
    if (errPed) throw errPed;
    return { vazio: itensRest.length === 0 };
  };

  const removerItemMutation = useMutation({
    mutationFn: async (itemId: number) => {
      const { error } = await supabase.from('pedido_compra_item').delete().eq('id', itemId);
      if (error) throw error;
      return await recalcularPedido();
    },
    onSuccess: (res) => {
      toast.success(res?.vazio ? 'Item removido. Pedido cancelado (sem itens restantes).' : 'Item removido');
      queryClient.invalidateQueries({ queryKey: ['pedido-itens', pedido?.id] });
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
      setRemoverItem(null);
      if (res?.vazio) onOpenChange(false);
    },
    onError: (e: Error) => {
      toast.error(`Erro ao remover item: ${e.message}`);
    },
  });

  const descontinuarMutation = useMutation({
    mutationFn: async (item: PedidoItem) => {
      // 1. descontinua o SKU
      const { error: errSku } = await supabase
        .from('sku_parametros')
        .update({
          tipo_reposicao: 'descontinuado',
          habilitado_reposicao_automatica: false,
        })
        .eq('empresa', pedido!.empresa)
        .eq('sku_codigo_omie', Number(item.sku_codigo_omie));
      if (errSku) throw errSku;
      // 2. remove a linha
      const { error: errDel } = await supabase.from('pedido_compra_item').delete().eq('id', item.id);
      if (errDel) throw errDel;
      return await recalcularPedido();
    },
    onSuccess: (res) => {
      toast.success(
        res?.vazio
          ? 'SKU descontinuado e item removido. Pedido cancelado (sem itens restantes).'
          : 'SKU descontinuado. Não será mais incluído em ciclos futuros.'
      );
      queryClient.invalidateQueries({ queryKey: ['pedido-itens', pedido?.id] });
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
      setDescontinuarItem(null);
      if (res?.vazio) onOpenChange(false);
    },
    onError: (e: Error) => {
      toast.error(`Erro ao descontinuar SKU: ${e.message}`);
    },
  });

  if (!pedido) return null;
  const podeEditar = pedido.status === 'pendente_aprovacao' || pedido.status === 'bloqueado_guardrail';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            Pedido #{pedido.id} — {pedido.fornecedor_nome}
            <StatusBadge status={pedido.status} />
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-muted-foreground">Grupo</div><div className="font-medium">{pedido.grupo_codigo ?? '—'}</div></div>
          <div><div className="text-muted-foreground">Nº SKUs</div><div className="font-medium">{pedido.num_skus}</div></div>
          <div><div className="text-muted-foreground">Valor total</div><div className="font-medium">{formatBRL(totalAtual || pedido.valor_total)}</div></div>
          <div><div className="text-muted-foreground">Horário corte</div><div className="font-medium">{formatTime(pedido.horario_corte_planejado)}</div></div>
        </div>

        {pedido.status === 'bloqueado_guardrail' && pedido.mensagem_bloqueio && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Bloqueado por guardrail</AlertTitle>
            <AlertDescription>Motivo: {pedido.mensagem_bloqueio}</AlertDescription>
          </Alert>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Estoque</TableHead>
                <TableHead className="text-right">PP</TableHead>
                <TableHead className="text-right">Emax</TableHead>
                <TableHead className="text-right">Qtde</TableHead>
                <TableHead className="text-right">Preço</TableHead>
                <TableHead className="text-right">Total linha</TableHead>
                {podeEditar && <TableHead className="text-right">Ações</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {linhas.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <div className="font-mono text-xs">{l.sku_codigo_omie}</div>
                    <div className="text-xs text-muted-foreground line-clamp-1">{l.sku_descricao ?? '—'}</div>
                    {l.primeira_compra && (
                      <Badge variant="destructive" className="mt-1 text-[10px] h-4">primeira compra</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.estoque_atual ?? 0).toFixed(0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.ponto_pedido ?? 0).toFixed(0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.estoque_maximo ?? 0).toFixed(0)}</TableCell>
                  <TableCell className="text-right">
                    {podeEditar ? (
                      <Input
                        type="number"
                        min={0}
                        step="1"
                        className="h-8 w-24 ml-auto text-right tabular-nums"
                        value={l._qtd}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setEdits((prev) => ({ ...prev, [l.id]: isNaN(v) ? 0 : v }));
                        }}
                      />
                    ) : (
                      <span className="tabular-nums">{l._qtd.toFixed(0)}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatBRL(l.preco_unitario)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatBRL(l._valor)}</TableCell>
                  {podeEditar && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Remover linha deste pedido"
                          onClick={() => setRemoverItem(l)}
                          disabled={removerItemMutation.isPending || descontinuarMutation.isPending}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Remover linha + descontinuar SKU"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDescontinuarItem(l)}
                          disabled={removerItemMutation.isPending || descontinuarMutation.isPending}
                        >
                          <Ban className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              <TableRow>
                <TableCell colSpan={6} className="text-right font-medium">Total</TableCell>
                <TableCell className="text-right font-bold tabular-nums">{formatBRL(totalAtual)}</TableCell>
                {podeEditar && <TableCell />}
              </TableRow>
            </TableBody>
          </Table>
        )}

        {podeEditar && (
          <div>
            <label className="text-sm text-muted-foreground mb-1 block">Observações internas (opcional)</label>
            <Textarea value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Notas sobre os ajustes..." />
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Fechar</Button>
          {podeEditar && (
            <>
              <Button
                variant="secondary"
                disabled={Object.keys(edits).length === 0 || salvarMutation.isPending}
                onClick={() => salvarMutation.mutate()}
              >
                {salvarMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                Salvar ajustes
              </Button>
              <Button
                disabled={aprovarMutation.isPending}
                onClick={() => aprovarMutation.mutate()}
              >
                {aprovarMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                ✓ Aprovar pedido completo
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>

      {/* Confirmação: remover linha */}
      <AlertDialog open={!!removerItem} onOpenChange={(v) => !v && setRemoverItem(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover este item do pedido?</AlertDialogTitle>
            <AlertDialogDescription>
              SKU <span className="font-mono">{removerItem?.sku_codigo_omie}</span> — {removerItem?.sku_descricao ?? '—'}.
              <br />O valor total do pedido será recalculado. Se for o último item, o pedido será cancelado automaticamente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removerItemMutation.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={removerItemMutation.isPending}
              onClick={() => removerItem && removerItemMutation.mutate(removerItem.id)}
            >
              {removerItemMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmação: remover + descontinuar */}
      <AlertDialog open={!!descontinuarItem} onOpenChange={(v) => !v && setDescontinuarItem(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Descontinuar SKU permanentemente?</AlertDialogTitle>
            <AlertDialogDescription>
              SKU <span className="font-mono">{descontinuarItem?.sku_codigo_omie}</span> — {descontinuarItem?.sku_descricao ?? '—'}.
              <br />
              <strong className="text-destructive">Tem certeza?</strong> Este SKU não será mais incluído em ciclos futuros de reposição automática.
              A linha também será removida deste pedido.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={descontinuarMutation.isPending}>Voltar</AlertDialogCancel>
            <AlertDialogAction
              disabled={descontinuarMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => descontinuarItem && descontinuarMutation.mutate(descontinuarItem)}
            >
              {descontinuarMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              Descontinuar e remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

/* ─── Cancelar Modal ─── */
function CancelarModal({
  pedido,
  open,
  onOpenChange,
}: {
  pedido: PedidoSugerido | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [justificativa, setJustificativa] = useState('');

  useEffect(() => {
    if (!open) setJustificativa('');
  }, [open]);

  const cancelarMutation = useMutation({
    mutationFn: async () => {
      if (!pedido) return;
      const { error } = await supabase.rpc('cancelar_pedido_sugerido', {
        p_pedido_id: pedido.id,
        p_usuario: user?.email ?? 'sistema',
        p_justificativa: justificativa.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Pedido cancelado');
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
      onOpenChange(false);
    },
    onError: (e: Error) => {
      toast.error(`Erro ao cancelar: ${e.message}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancelar pedido #{pedido?.id}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium">Justificativa <span className="text-destructive">*</span></label>
          <Textarea
            value={justificativa}
            onChange={(e) => setJustificativa(e.target.value)}
            placeholder="Explique o motivo do cancelamento..."
            rows={4}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Voltar</Button>
          <Button
            variant="destructive"
            disabled={!justificativa.trim() || cancelarMutation.isPending}
            onClick={() => cancelarMutation.mutate()}
          >
            {cancelarMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Confirmar cancelamento
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Linha do pedido ─── */
function PedidoRow({
  p,
  onVerDetalhes,
  onCancelar,
}: {
  p: PedidoSugerido;
  onVerDetalhes: () => void;
  onCancelar: () => void;
}) {
  const podeAprovar = p.status === 'pendente_aprovacao' || p.status === 'bloqueado_guardrail';
  const podeCancelar = ['pendente_aprovacao', 'bloqueado_guardrail', 'aprovado_aguardando_disparo'].includes(p.status);

  const showAprovacao = p.status === 'aprovado_aguardando_disparo' || p.status === 'disparado';

  return (
    <TableRow className={p.status === 'bloqueado_guardrail' ? 'bg-destructive/5' : ''}>
      <TableCell><StatusBadge status={p.status} /></TableCell>
      <TableCell>
        <div className="font-medium">{p.fornecedor_nome}</div>
        <div className="text-xs text-muted-foreground">{p.grupo_codigo ?? '—'}</div>
      </TableCell>
      <TableCell className="text-right tabular-nums">{p.num_skus}</TableCell>
      <TableCell className="text-right tabular-nums font-medium">{formatBRL(p.valor_total)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {p.delta_vs_anterior_perc !== null ? (
          <span className={Number(p.delta_vs_anterior_perc) >= 0 ? 'text-emerald-600' : 'text-destructive'}>
            {Number(p.delta_vs_anterior_perc) >= 0 ? '+' : ''}{Number(p.delta_vs_anterior_perc).toFixed(1)}%
          </span>
        ) : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="text-right">{formatTime(p.horario_corte_planejado)}</TableCell>
      <TableCell className="text-xs">
        {showAprovacao && p.aprovado_em ? (
          <div>
            <div className="font-medium tabular-nums">{format(new Date(p.aprovado_em), 'dd/MM HH:mm')}</div>
            <div className="text-muted-foreground line-clamp-1">{p.aprovado_por ?? '—'}</div>
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={onVerDetalhes}>
            <Eye className="w-4 h-4 mr-1" />Detalhes
          </Button>
          {podeAprovar && (
            <Button size="sm" variant="default" onClick={onVerDetalhes}>Aprovar</Button>
          )}
          {podeCancelar && (
            <Button size="sm" variant="outline" onClick={onCancelar}>
              <XCircle className="w-4 h-4" />
            </Button>
          )}
          {p.status === 'disparado' && p.omie_pedido_compra_numero && (
            <Button size="sm" variant="ghost" asChild>
              <a href={`https://app.omie.com.br/`} target="_blank" rel="noreferrer">
                <ExternalLink className="w-4 h-4 mr-1" />Omie
              </a>
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/* ─── Página principal ─── */
export default function AdminReposicaoPedidos() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [now, setNow] = useState(new Date());
  const [detalhesPedido, setDetalhesPedido] = useState<PedidoSugerido | null>(null);
  const [cancelarPedido, setCancelarPedido] = useState<PedidoSugerido | null>(null);
  const [historicoData, setHistoricoData] = useState<string>(() => format(new Date(), 'yyyy-MM-dd'));

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const dataHoje = format(now, 'yyyy-MM-dd');

  const { data: pedidos, isLoading, refetch } = useQuery({
    queryKey: ['pedidos-ciclo', dataHoje],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pedido_compra_sugerido')
        .select('*')
        .eq('empresa', EMPRESA)
        .eq('data_ciclo', dataHoje)
        .order('fornecedor_nome', { ascending: true });
      if (error) throw error;
      return (data ?? []) as PedidoSugerido[];
    },
    refetchInterval: 30_000,
  });

  // Deep link: abrir modal automaticamente quando ?id= estiver presente
  useEffect(() => {
    const idParam = searchParams.get('id');
    if (!idParam || !pedidos) return;
    const idNum = Number(idParam);
    if (Number.isNaN(idNum)) return;
    if (detalhesPedido?.id === idNum) return;
    const found = pedidos.find((p) => p.id === idNum);
    if (found) {
      setDetalhesPedido(found);
    } else {
      toast.error(`Pedido #${idNum} não encontrado no ciclo de hoje`);
      // limpa o param inválido
      const next = new URLSearchParams(searchParams);
      next.delete('id');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, pedidos, detalhesPedido?.id, setSearchParams]);

  const handleCloseDetalhes = (open: boolean) => {
    if (!open) {
      setDetalhesPedido(null);
      if (searchParams.has('id')) {
        const next = new URLSearchParams(searchParams);
        next.delete('id');
        setSearchParams(next, { replace: true });
      }
    }
  };

  const gerarMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('gerar_pedidos_sugeridos_ciclo', {
        p_empresa: EMPRESA,
        p_data_ciclo: dataHoje,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      const r = Array.isArray(data) ? data[0] : data;
      toast.success(`${r?.pedidos_gerados ?? 0} pedidos gerados — ${r?.bloqueados ?? 0} bloqueados`);
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
    },
    onError: (e: Error) => {
      toast.error(`Erro ao gerar: ${e.message}`);
    },
  });

  const bloqueados = (pedidos ?? []).filter((p) => p.status === 'bloqueado_guardrail');

  return (
    <div className="container mx-auto py-6 space-y-6 max-w-7xl">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Pedidos de compra — CICLO DE HOJE ({format(now, 'dd/MM/yyyy', { locale: ptBR })})
          </h1>
          <div className="mt-2"><CycleIndicator now={now} /></div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`w-4 h-4 mr-1 ${isLoading ? 'animate-spin' : ''}`} />Atualizar
          </Button>
          <Button onClick={() => gerarMutation.mutate()} disabled={gerarMutation.isPending}>
            {gerarMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Rodar geração manual
          </Button>
        </div>
      </div>

      {bloqueados.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Atenção</AlertTitle>
          <AlertDescription>
            {bloqueados.length} pedido(s) bloqueado(s) por guardrail. Revise antes do disparo.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="hoje">
        <TabsList>
          <TabsTrigger value="hoje">Ciclo de hoje</TabsTrigger>
          <TabsTrigger value="historico">Ciclos anteriores</TabsTrigger>
        </TabsList>

        <TabsContent value="hoje">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pedidos do dia ({pedidos?.length ?? 0})</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : (pedidos ?? []).length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  Nenhum pedido gerado para o ciclo de hoje. Use "Rodar geração manual" para criar.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Fornecedor / Grupo</TableHead>
                      <TableHead className="text-right">Nº SKUs</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                      <TableHead className="text-right">Δ vs anterior</TableHead>
                      <TableHead className="text-right">Corte</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pedidos!.map((p) => (
                      <PedidoRow
                        key={p.id}
                        p={p}
                        onVerDetalhes={() => setDetalhesPedido(p)}
                        onCancelar={() => setCancelarPedido(p)}
                      />
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="historico">
          <CiclosAnteriores data={historicoData} onChange={setHistoricoData} />
        </TabsContent>
      </Tabs>

      <DetalhesModal
        pedido={detalhesPedido}
        open={!!detalhesPedido}
        onOpenChange={handleCloseDetalhes}
        onApproved={() => handleCloseDetalhes(false)}
      />
      <CancelarModal
        pedido={cancelarPedido}
        open={!!cancelarPedido}
        onOpenChange={(v) => !v && setCancelarPedido(null)}
      />
    </div>
  );
}

/* ─── Ciclos anteriores ─── */
function CiclosAnteriores({ data, onChange }: { data: string; onChange: (v: string) => void }) {
  const { data: historico, isLoading } = useQuery({
    queryKey: ['historico-ciclos', data],
    queryFn: async () => {
      // últimos 30 dias agregados
      const desde = new Date();
      desde.setDate(desde.getDate() - 30);
      const { data: rows, error } = await supabase
        .from('pedido_compra_sugerido')
        .select('data_ciclo,fornecedor_nome,status,valor_total')
        .eq('empresa', EMPRESA)
        .gte('data_ciclo', format(desde, 'yyyy-MM-dd'))
        .order('data_ciclo', { ascending: false });
      if (error) throw error;
      // agrupa por dia
      const grupos = new Map<string, { fornecedores: Set<string>; pedidos: number; valor: number; disparados: number; cancelados: number }>();
      for (const r of rows ?? []) {
        const k = r.data_ciclo as string;
        if (!grupos.has(k)) grupos.set(k, { fornecedores: new Set(), pedidos: 0, valor: 0, disparados: 0, cancelados: 0 });
        const g = grupos.get(k)!;
        g.fornecedores.add(r.fornecedor_nome);
        g.pedidos += 1;
        g.valor += Number(r.valor_total ?? 0);
        if (r.status === 'disparado') g.disparados += 1;
        if (r.status === 'cancelado') g.cancelados += 1;
      }
      return Array.from(grupos.entries()).map(([dia, g]) => ({
        dia,
        fornecedores: g.fornecedores.size,
        pedidos: g.pedidos,
        valor: g.valor,
        disparados: g.disparados,
        cancelados: g.cancelados,
      }));
    },
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">Últimos 30 dias</CardTitle>
        <Input type="date" value={data} onChange={(e) => onChange(e.target.value)} className="w-44" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (historico ?? []).length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">Sem ciclos no período.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead className="text-right">Fornecedores</TableHead>
                <TableHead className="text-right">Pedidos</TableHead>
                <TableHead className="text-right">Valor total</TableHead>
                <TableHead className="text-right">Disparados</TableHead>
                <TableHead className="text-right">Cancelados</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {historico!.map((h) => (
                <TableRow key={h.dia}>
                  <TableCell className="font-medium">{format(new Date(h.dia + 'T12:00:00'), 'dd/MM/yyyy')}</TableCell>
                  <TableCell className="text-right tabular-nums">{h.fornecedores}</TableCell>
                  <TableCell className="text-right tabular-nums">{h.pedidos}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBRL(h.valor)}</TableCell>
                  <TableCell className="text-right tabular-nums text-emerald-600">{h.disparados}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{h.cancelados}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
