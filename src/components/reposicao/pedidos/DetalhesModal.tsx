import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { AlertTriangle, Ban, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { PedidoSugerido, PedidoItem, CondicaoPagamento, StatusEnvioPortal } from './types';
import { getEstoqueZoneClass, formatBRL, formatTime, portalStatusMeta } from './shared';
import { StatusBadge, SplitInfo } from './badges';

/* ─── Painel: Status de envio ao portal ─── */
function PortalStatusPanel({ pedido }: { pedido: PedidoSugerido | null }) {
  if (!pedido) return null;
  const status = (pedido.status_envio_portal ?? 'nao_aplicavel') as StatusEnvioPortal;
  const meta = portalStatusMeta[status] ?? portalStatusMeta.nao_aplicavel;
  const tentativas = pedido.portal_tentativas ?? 0;
  const fmt = (iso: string | null | undefined) => {
    if (!iso) return '—';
    try { return format(new Date(iso), "dd/MM/yyyy HH:mm", { locale: ptBR }); } catch { return '—'; }
  };
  return (
    <div className="rounded-md border bg-muted/20 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Status de envio ao portal</div>
        <span className={cn(
          'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold',
          meta.className,
        )}>{meta.label}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Enviado em</dt>
        <dd className="text-right tabular-nums">{fmt(pedido.enviado_portal_em)}</dd>
        <dt className="text-muted-foreground">Protocolo</dt>
        <dd className="text-right font-mono">{pedido.portal_protocolo ?? '—'}</dd>
        <dt className="text-muted-foreground">Tentativas</dt>
        <dd className="text-right tabular-nums">{tentativas}</dd>
        <dt className="text-muted-foreground">Próx. retry</dt>
        <dd className="text-right tabular-nums">{fmt(pedido.portal_proximo_retry_em)}</dd>
      </dl>
      {pedido.portal_erro && (
        <div className="text-xs text-destructive whitespace-pre-wrap break-words border-t pt-2">
          {pedido.portal_erro}
        </div>
      )}
    </div>
  );
}

/* ─── Painel: Histórico de ações ─── */
function HistoricoAcoesPanel({ pedido }: { pedido: PedidoSugerido | null }) {
  if (!pedido) return null;
  type Evt = { ts: string; label: string; by?: string | null; detail?: string | null; tone: 'default' | 'success' | 'warn' | 'danger' };
  const evts: Evt[] = [];
  if (pedido.criado_em) evts.push({ ts: pedido.criado_em, label: 'Pedido gerado', tone: 'default' });
  if (pedido.aprovado_em) evts.push({ ts: pedido.aprovado_em, label: 'Aprovado', by: pedido.aprovado_por, tone: 'success' });
  if (pedido.enviado_portal_em) {
    evts.push({
      ts: pedido.enviado_portal_em,
      label: 'Enviado ao portal',
      detail: pedido.portal_protocolo ? `Protocolo ${pedido.portal_protocolo}` : null,
      tone: pedido.status_envio_portal === 'falha_envio_portal' ? 'danger' : 'success',
    });
  }
  if (pedido.horario_disparo_real) evts.push({ ts: pedido.horario_disparo_real, label: 'Disparado', tone: 'success' });
  if (pedido.omie_registrado_em) evts.push({
    ts: pedido.omie_registrado_em,
    label: 'Registrado no Omie',
    detail: pedido.omie_pedido_compra_numero ? `Nº ${pedido.omie_pedido_compra_numero}` : null,
    tone: 'success',
  });
  if (pedido.cancelado_em) evts.push({
    ts: pedido.cancelado_em,
    label: 'Cancelado',
    by: pedido.cancelado_por,
    detail: pedido.justificativa_cancelamento,
    tone: 'danger',
  });
  evts.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  const fmt = (iso: string) => {
    try { return format(new Date(iso), "dd/MM/yyyy HH:mm", { locale: ptBR }); } catch { return iso; }
  };
  const dotCls: Record<Evt['tone'], string> = {
    default: 'bg-muted-foreground',
    success: 'bg-status-success',
    warn: 'bg-status-warning',
    danger: 'bg-destructive',
  };
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="text-sm font-medium mb-2">Histórico de ações</div>
      {evts.length === 0 ? (
        <div className="text-xs text-muted-foreground py-2">Sem eventos registrados.</div>
      ) : (
        <ol className="space-y-2.5">
          {evts.map((e, i) => (
            <li key={i} className="flex gap-2.5 text-xs">
              <div className="flex flex-col items-center pt-0.5">
                <span className={cn('h-2 w-2 rounded-full', dotCls[e.tone])} />
                {i < evts.length - 1 && <span className="flex-1 w-px bg-border mt-1" />}
              </div>
              <div className="flex-1 pb-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{e.label}</span>
                  <span className="tabular-nums text-muted-foreground">{fmt(e.ts)}</span>
                </div>
                {(e.by || e.detail) && (
                  <div className="text-muted-foreground mt-0.5 break-words">
                    {e.by && <span>por {e.by}</span>}
                    {e.by && e.detail && <span> · </span>}
                    {e.detail && <span>{e.detail}</span>}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ─── Detalhes Modal ─── */
export function DetalhesModal({
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
  const [condicaoCodigo, setCondicaoCodigo] = useState<string>('');
  const [removerItem, setRemoverItem] = useState<PedidoItem | null>(null);
  const [descontinuarItem, setDescontinuarItem] = useState<PedidoItem | null>(null);

  // Catálogo de condições de pagamento Omie (carregado uma vez)
  const { data: condicoes = [] } = useQuery({
    queryKey: ['condicoes-pagamento', pedido?.empresa],
    queryFn: async () => {
      if (!pedido) return [] as CondicaoPagamento[];
      const { data, error } = await supabase
        .from('omie_condicao_pagamento_catalogo')
        .select('codigo, descricao, num_parcelas, dias_parcelas')
        .eq('empresa', pedido.empresa)
        .eq('ativo', true)
        .order('descricao');
      if (error) throw error;
      return (data ?? []) as CondicaoPagamento[];
    },
    enabled: !!pedido && open,
  });

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
      const baseItens = data ?? [];
      if (baseItens.length === 0) return [] as PedidoItem[];

      // Buscar estoque_minimo de sku_parametros (JOIN manual)
      const skuCodigos = baseItens.map((it) => Number(it.sku_codigo_omie)).filter((n) => !isNaN(n));
      const { data: params } = await supabase
        .from('sku_parametros')
        .select('sku_codigo_omie, estoque_minimo')
        .eq('empresa', pedido.empresa)
        .in('sku_codigo_omie', skuCodigos);
      const minMap = new Map<string, number>();
      (params ?? []).forEach((p) => {
        minMap.set(String(p.sku_codigo_omie), Number(p.estoque_minimo ?? 0));
      });

      return baseItens.map((it) => ({
        ...it,
        estoque_minimo: minMap.get(String(it.sku_codigo_omie)) ?? 0,
      })) as PedidoItem[];
    },
    enabled: !!pedido && open,
  });

  useEffect(() => {
    if (!open) {
      setEdits({});
      setObs('');
      setCondicaoCodigo('');
    } else if (pedido) {
      setCondicaoCodigo(pedido.condicao_pagamento_codigo ?? '');
    }
  }, [open, pedido]);

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

  const condicaoSelecionada = useMemo(
    () => condicoes.find((c) => c.codigo === condicaoCodigo) ?? null,
    [condicoes, condicaoCodigo],
  );

  const condicaoMudou = condicaoCodigo !== (pedido?.condicao_pagamento_codigo ?? '');

  const salvarCondicaoMutation = useMutation({
    mutationFn: async () => {
      if (!pedido || !condicaoSelecionada) return;
      const { error } = await supabase
        .from('pedido_compra_sugerido')
        .update({
          condicao_pagamento_codigo: condicaoSelecionada.codigo,
          condicao_pagamento_descricao: condicaoSelecionada.descricao,
          num_parcelas: condicaoSelecionada.num_parcelas,
          condicao_origem: 'manual_humano',
          atualizado_em: new Date().toISOString(),
        })
        .eq('id', pedido.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Condição de pagamento salva');
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
    },
    onError: (e: Error) => {
      logger.error('Erro ao salvar condição', { error: e });
      toast.error(`Erro ao salvar condição: ${e.message}`);
    },
  });

  const aprovarMutation = useMutation({
    mutationFn: async () => {
      if (!pedido) return;
      if (!condicaoSelecionada) {
        throw new Error('Selecione uma condição de pagamento antes de aprovar');
      }
      // salvar ajustes primeiro se houver
      if (Object.keys(edits).length > 0) {
        await salvarMutation.mutateAsync();
      }
      // salvar condição se mudou ou se ainda não havia
      if (condicaoMudou) {
        await salvarCondicaoMutation.mutateAsync();
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
  const podeEditarCondicao = podeEditar || pedido.status === 'aprovado_aguardando_disparo';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-7xl xl:max-w-screen-2xl w-[95vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 flex-wrap">
            Pedido #{pedido.id} — {pedido.fornecedor_nome}
            <StatusBadge status={pedido.status} />
            <SplitInfo pedido={pedido} />
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-muted-foreground">Grupo</div><div className="font-medium">{pedido.grupo_codigo ?? '—'}</div></div>
          <div><div className="text-muted-foreground">Nº SKUs</div><div className="font-medium">{pedido.num_skus}</div></div>
          <div><div className="text-muted-foreground">Valor total</div><div className="font-medium">{formatBRL(totalAtual || pedido.valor_total)}</div></div>
          <div><div className="text-muted-foreground">Horário corte</div><div className="font-medium">{formatTime(pedido.horario_corte_planejado)}</div></div>
        </div>

        {/* Condição de pagamento Omie (obrigatório p/ disparo) */}
        <div className="rounded-md border bg-muted/30 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">
              Condição de pagamento Omie
              {!condicaoSelecionada && <span className="text-destructive ml-1">*</span>}
            </label>
            {pedido.condicao_origem && (
              <Badge variant="outline" className="text-[10px] h-4">
                origem: {pedido.condicao_origem}
              </Badge>
            )}
          </div>
          {podeEditarCondicao ? (
            <div className="flex gap-2">
              <Select value={condicaoCodigo || undefined} onValueChange={setCondicaoCodigo}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Selecione a condição (obrigatório p/ disparar ao Omie)" />
                </SelectTrigger>
                <SelectContent className="max-h-[300px]">
                  {condicoes.map((c) => (
                    <SelectItem key={c.codigo} value={c.codigo}>
                      <span className="font-mono text-xs mr-2">{c.codigo}</span>
                      {c.descricao}
                      {c.num_parcelas ? <span className="text-muted-foreground ml-2">({c.num_parcelas}x)</span> : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {pedido.status === 'aprovado_aguardando_disparo' && condicaoMudou && condicaoSelecionada && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={salvarCondicaoMutation.isPending}
                  onClick={() => salvarCondicaoMutation.mutate()}
                >
                  {salvarCondicaoMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                  Salvar
                </Button>
              )}
            </div>
          ) : (
            <div className="text-sm">
              {pedido.condicao_pagamento_codigo
                ? <><span className="font-mono text-xs mr-2">{pedido.condicao_pagamento_codigo}</span>{pedido.condicao_pagamento_descricao}</>
                : <span className="text-muted-foreground italic">não definida</span>}
            </div>
          )}
          {!condicaoSelecionada && podeEditarCondicao && (
            <p className="text-xs text-destructive">
              Sem condição selecionada o disparo ao Omie falhará.
            </p>
          )}
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
                <TableHead className="w-[34%] min-w-[300px]">SKU / Descrição</TableHead>
                <TableHead className="text-right">Estoque atual</TableHead>
                <TableHead className="text-right">EM</TableHead>
                <TableHead className="text-right">PP</TableHead>
                <TableHead className="text-right">Emax</TableHead>
                <TableHead className="text-right">Qtde sugerida</TableHead>
                <TableHead className="text-right">Qtde final</TableHead>
                <TableHead className="text-right">Preço</TableHead>
                <TableHead className="text-right">Valor linha</TableHead>
                {podeEditar && <TableHead className="text-right">Ações</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {linhas.map((l) => {
                const estoque = Number(l.estoque_atual ?? 0);
                const minimo = Number(l.estoque_minimo ?? 0);
                const pp = Number(l.ponto_pedido ?? 0);
                const zoneClass = getEstoqueZoneClass(estoque, minimo, pp);
                const sugerida = Number(l.qtde_sugerida ?? 0);
                return (
                <TableRow key={l.id}>
                  <TableCell className="align-top whitespace-normal">
                    <div className="font-mono text-xs text-muted-foreground">{l.sku_codigo_omie}</div>
                    <div className="text-sm font-medium whitespace-normal break-words leading-snug">
                      {l.sku_descricao ?? '—'}
                    </div>
                    <div className="flex gap-1 mt-1">
                      {l.primeira_compra && (
                        <Badge variant="destructive" className="text-[10px] h-4">primeira compra</Badge>
                      )}
                      {l.ajustado_humano && (
                        <Badge variant="outline" className="text-[10px] h-4">ajustado</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className={`text-right tabular-nums ${zoneClass}`}>{estoque.toFixed(0)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{minimo.toFixed(0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pp.toFixed(0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.estoque_maximo ?? 0).toFixed(0)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{sugerida.toFixed(0)}</TableCell>
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
                      <span className={cn(
                        "tabular-nums",
                        l._qtd !== sugerida && "font-semibold text-status-warning",
                      )}>{l._qtd.toFixed(0)}</span>
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
                );
              })}
              <TableRow>
                <TableCell colSpan={8} className="text-right font-medium">Total</TableCell>
                <TableCell className="text-right font-bold tabular-nums">{formatBRL(totalAtual)}</TableCell>
                {podeEditar && <TableCell />}
              </TableRow>
            </TableBody>
          </Table>
        )}

        {/* Status de envio ao portal + Histórico de ações */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <PortalStatusPanel pedido={pedido} />
          <HistoricoAcoesPanel pedido={pedido} />
        </div>


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
                disabled={aprovarMutation.isPending || !condicaoSelecionada}
                onClick={() => aprovarMutation.mutate()}
                title={!condicaoSelecionada ? 'Selecione a condição de pagamento antes de aprovar' : ''}
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
