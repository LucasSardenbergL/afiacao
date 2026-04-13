import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  ArrowLeft, Truck, Plus, Loader2, ScanLine, Keyboard, Copy,
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, X, Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import LoteScannerOCR from '@/components/recebimento/LoteScannerOCR';

type ItemStatus = 'pendente' | 'em_conferencia' | 'conferido' | 'divergencia';

const STATUS_COLORS: Record<ItemStatus, string> = {
  pendente: 'bg-muted text-muted-foreground',
  em_conferencia: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  conferido: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  divergencia: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
};

const STATUS_LABELS: Record<ItemStatus, string> = {
  pendente: 'Pendente',
  em_conferencia: 'Em conferência',
  conferido: 'Conferido',
  divergencia: 'Divergência',
};

function formatCurrency(v: number | null) {
  if (v == null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

function formatDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('pt-BR');
}

export default function RecebimentoConferencia() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // State
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [lote, setLote] = useState('');
  const [fabricacao, setFabricacao] = useState('');
  const [validade, setValidade] = useState('');
  const [metodo, setMetodo] = useState<'ocr' | 'manual'>('manual');
  const [saving, setSaving] = useState(false);
  const [lastLote, setLastLote] = useState<{ numero_lote: string; data_fabricacao: string; data_validade: string } | null>(null);
  const [divergenciaItemId, setDivergenciaItemId] = useState<string | null>(null);
  const [divergenciaText, setDivergenciaText] = useState('');
  const [cteModalOpen, setCteModalOpen] = useState(false);
  const [cteChave, setCteChave] = useState('');
  const [cteXml, setCteXml] = useState('');
  const [cteSaving, setCteSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  // Fetch NF-e
  const { data: nfe, isLoading } = useQuery({
    queryKey: ['nfe_conferencia', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('nfe_recebimentos')
        .select(`
          *,
          nfe_recebimento_itens(*),
          cte_associados(*)
        `)
        .eq('id', id!)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });

  // Fetch scanned lotes grouped
  const { data: lotes } = useQuery({
    queryKey: ['nfe_lotes', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('nfe_lotes_escaneados')
        .select('*')
        .eq('nfe_recebimento_id', id!);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!id,
  });

  // Group lotes by item
  const lotesPerItem = useMemo(() => {
    const map = new Map<string, Map<string, { count: number; fab: string | null; val: string | null }>>();
    (lotes ?? []).forEach((l: any) => {
      if (!map.has(l.nfe_recebimento_item_id)) map.set(l.nfe_recebimento_item_id, new Map());
      const itemMap = map.get(l.nfe_recebimento_item_id)!;
      const existing = itemMap.get(l.numero_lote);
      if (existing) {
        existing.count += 1;
      } else {
        itemMap.set(l.numero_lote, { count: 1, fab: l.data_fabricacao, val: l.data_validade });
      }
    });
    return map;
  }, [lotes]);

  // Compute globals
  const items = (nfe?.nfe_recebimento_itens ?? []) as any[];
  const totalEsperada = items.reduce((s: number, i: any) => s + (i.quantidade_esperada ?? 0), 0);
  const totalConferida = items.reduce((s: number, i: any) => s + (i.quantidade_conferida ?? 0), 0);
  const progressPct = totalEsperada > 0 ? Math.round((totalConferida / totalEsperada) * 100) : 0;

  const allConferido = items.length > 0 && items.every((i: any) => i.status_item === 'conferido');
  const hasDivergencia = items.some((i: any) => i.status_item === 'divergencia');
  const canFinalize = allConferido || hasDivergencia;

  // Active item
  const activeItem = items.find((i: any) => i.id === activeItemId);
  const activeConferida = activeItem?.quantidade_conferida ?? 0;
  const activeEsperada = activeItem?.quantidade_esperada ?? 0;
  const currentUnit = activeConferida + 1;

  // Reset scan form when opening item
  const openItemSheet = (itemId: string) => {
    setActiveItemId(itemId);
    resetScanForm();
    setManualMode(false);
    setScannerOpen(false);
  };

  const resetScanForm = () => {
    setLote('');
    setFabricacao('');
    setValidade('');
    setMetodo('manual');
  };

  // Handle OCR result
  const handleOcrResult = (dados: { numero_lote: string; data_fabricacao: string | null; data_validade: string | null; metodo_leitura: 'ocr' | 'manual' }) => {
    setLote(dados.numero_lote);
    setFabricacao(dados.data_fabricacao ?? '');
    setValidade(dados.data_validade ?? '');
    setMetodo(dados.metodo_leitura);
    setScannerOpen(false);
    setManualMode(true);
  };

  // Repeat last lote
  const handleRepeatLote = () => {
    if (!lastLote) return;
    setLote(lastLote.numero_lote);
    setFabricacao(lastLote.data_fabricacao);
    setValidade(lastLote.data_validade);
    setMetodo('manual');
    setManualMode(true);
  };

  // Confirm unit
  const handleConfirmUnit = async () => {
    if (!lote.trim() || !validade || !activeItemId || !id) return;
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();

      // Insert lote record
      const { error: insertErr } = await supabase
        .from('nfe_lotes_escaneados')
        .insert({
          nfe_recebimento_id: id,
          nfe_recebimento_item_id: activeItemId,
          numero_lote: lote.trim(),
          data_fabricacao: fabricacao || null,
          data_validade: validade,
          metodo_leitura: metodo,
          escaneado_por: user?.id ?? null,
        });
      if (insertErr) throw insertErr;

      const newConferida = activeConferida + 1;
      const newStatus: ItemStatus = newConferida >= activeEsperada ? 'conferido' : 'em_conferencia';

      // Update item
      const { error: updErr } = await supabase
        .from('nfe_recebimento_itens')
        .update({ quantidade_conferida: newConferida, status_item: newStatus })
        .eq('id', activeItemId);
      if (updErr) throw updErr;

      // Update nfe status if needed
      if ((nfe as any)?.status === 'pendente') {
        await supabase.from('nfe_recebimentos').update({ status: 'em_conferencia' }).eq('id', id);
      }

      // Remember last lote
      setLastLote({ numero_lote: lote.trim(), data_fabricacao: fabricacao, data_validade: validade });

      // Refresh
      await queryClient.invalidateQueries({ queryKey: ['nfe_conferencia', id] });
      await queryClient.invalidateQueries({ queryKey: ['nfe_lotes', id] });

      if (newConferida >= activeEsperada) {
        toast.success(`Item conferido! ${newConferida}/${activeEsperada} unidades`);
        setActiveItemId(null);
      } else {
        // Advance to next unit
        resetScanForm();
        setManualMode(false);
      }
    } catch (err: any) {
      toast.error('Erro ao salvar: ' + (err.message ?? 'Tente novamente'));
    } finally {
      setSaving(false);
    }
  };

  // Report divergence
  const handleReportDivergencia = async () => {
    if (!divergenciaItemId || !divergenciaText.trim()) return;
    setSaving(true);
    try {
      await supabase
        .from('nfe_recebimento_itens')
        .update({ status_item: 'divergencia', observacao: divergenciaText.trim() })
        .eq('id', divergenciaItemId);

      await supabase.from('nfe_recebimentos').update({ status: 'divergencia' }).eq('id', id!);

      toast.success('Divergência registrada');
      setDivergenciaItemId(null);
      setDivergenciaText('');
      queryClient.invalidateQueries({ queryKey: ['nfe_conferencia', id] });
    } catch (err: any) {
      toast.error('Erro: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  // Add CT-e
  const handleAddCte = async () => {
    const clean = cteChave.replace(/\s/g, '');
    if (clean.length !== 44 && !cteXml.trim()) {
      toast.error('Informe a chave de acesso (44 dígitos) ou o XML');
      return;
    }
    setCteSaving(true);
    try {
      await supabase.from('cte_associados').insert({
        nfe_recebimento_id: id!,
        chave_acesso_cte: clean || `XML-${Date.now()}`,
        xml_cte: cteXml.trim() || null,
        status: 'pendente',
      });
      toast.success('CT-e vinculado');
      setCteModalOpen(false);
      setCteChave('');
      setCteXml('');
      queryClient.invalidateQueries({ queryKey: ['nfe_conferencia', id] });
    } catch (err: any) {
      toast.error('Erro: ' + err.message);
    } finally {
      setCteSaving(false);
    }
  };

  // Finalize
  const handleFinalize = async () => {
    setFinalizing(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const finalStatus = hasDivergencia ? 'divergencia' : 'conferido';

      await supabase.from('nfe_recebimentos').update({
        status: finalStatus,
        conferente_id: user?.id ?? null,
        conferido_at: new Date().toISOString(),
      }).eq('id', id!);

      if (!hasDivergencia) {
        // Call efetivação
        const { data: { session } } = await supabase.auth.getSession();
        const res = await supabase.functions.invoke('omie-nfe-recebimento', {
          body: { nfe_recebimento_id: id },
          headers: { Authorization: `Bearer ${session?.access_token}` },
        });
        if (res.error) throw res.error;

        const totalLotes = new Set((lotes ?? []).map((l: any) => l.numero_lote)).size;
        toast.success(`NF-e ${(nfe as any)?.numero_nfe} efetivada — ${totalConferida} unidades, ${totalLotes} lotes registrados`);
      } else {
        toast.warning('Conferência finalizada com divergências. Aguardando resolução.');
      }

      navigate('/recebimento');
    } catch (err: any) {
      toast.error('Erro ao finalizar: ' + (err.message ?? 'Tente novamente'));
    } finally {
      setFinalizing(false);
    }
  };

  const toggleExpand = (itemId: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      next.has(itemId) ? next.delete(itemId) : next.add(itemId);
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!nfe) {
    return (
      <div className="max-w-lg mx-auto py-20 text-center text-muted-foreground">
        NF-e não encontrada
      </div>
    );
  }

  const ctes = (nfe as any).cte_associados ?? [];

  // Scanner full-screen overlay
  if (scannerOpen) {
    return (
      <LoteScannerOCR
        onLoteCapturado={handleOcrResult}
        onCancelar={() => setScannerOpen(false)}
      />
    );
  }

  return (
    <div className="max-w-2xl mx-auto pb-32">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-background border-b border-border px-4 py-3 space-y-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/recebimento')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-foreground truncate">
              NF-e {(nfe as any).numero_nfe}
            </h1>
            <p className="text-xs text-muted-foreground truncate">
              {(nfe as any).razao_social_emitente} · {formatDate((nfe as any).data_emissao)} · {formatCurrency((nfe as any).valor_total)}
            </p>
          </div>
        </div>

        {/* Global progress */}
        <div className="space-y-1">
          <div className="flex justify-between text-sm">
            <span className="font-medium text-foreground">{totalConferida} de {totalEsperada} unidades</span>
            <span className="text-muted-foreground">{progressPct}%</span>
          </div>
          <Progress value={progressPct} className="h-3" />
        </div>
      </div>

      <div className="px-4 space-y-4 mt-4">
        {/* Transport section */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground mb-2">Transporte</h2>
          {ctes.length > 0 ? (
            <div className="space-y-2">
              {ctes.map((cte: any) => (
                <Card key={cte.id}>
                  <CardContent className="p-3 flex items-center gap-3">
                    <Truck className="h-5 w-5 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        CT-e {cte.numero_cte || cte.chave_acesso_cte?.slice(-8)}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {cte.razao_social_transportadora || 'Transportadora'} · {formatCurrency(cte.valor_frete)}
                      </p>
                    </div>
                    <Badge className={cn('text-xs', cte.status === 'efetivado' ? 'bg-muted text-muted-foreground' : 'bg-amber-100 text-amber-800')}>
                      {cte.status}
                    </Badge>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setCteModalOpen(true)}>
              <Plus className="h-4 w-4" /> Vincular CT-e
            </Button>
          )}
        </div>

        {/* Items */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground mb-2">
            Itens ({items.length})
          </h2>
          <div className="space-y-3">
            {items.map((item: any) => {
              const esperada = item.quantidade_esperada ?? 0;
              const conferida = item.quantidade_conferida ?? 0;
              const pct = esperada > 0 ? Math.round((conferida / esperada) * 100) : 0;
              const status = (item.status_item ?? 'pendente') as ItemStatus;
              const itemLotes = lotesPerItem.get(item.id);
              const isExpanded = expandedItems.has(item.id);
              const hasConversao = item.quantidade_convertida != null && item.quantidade_convertida !== item.quantidade_nfe;
              const isClickable = status !== 'conferido';

              return (
                <Card key={item.id} className={cn(isClickable && 'cursor-pointer hover:border-primary/50')}>
                  <CardContent className="p-3 space-y-2">
                    {/* Item header */}
                    <div className="flex items-start justify-between gap-2" onClick={() => isClickable && openItemSheet(item.id)}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {item.descricao_produto}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Cód: {item.codigo_produto}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-lg font-bold text-foreground">
                          {esperada} {item.unidade_estoque ?? 'UN'}
                        </p>
                        {hasConversao && (
                          <p className="text-[10px] text-muted-foreground leading-tight">
                            NF-e: {item.quantidade_nfe} {item.unidade_nfe} ÷ {(item.quantidade_nfe / item.quantidade_convertida).toFixed(3)}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Progress */}
                    <div className="flex items-center gap-2">
                      <Progress value={pct} className="h-2 flex-1" />
                      <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
                        {conferida}/{esperada}
                      </span>
                      <Badge className={cn('text-[10px] px-1.5 py-0', STATUS_COLORS[status])}>
                        {STATUS_LABELS[status]}
                      </Badge>
                    </div>

                    {/* Lotes list */}
                    {itemLotes && itemLotes.size > 0 && (
                      <div>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleExpand(item.id); }}
                          className="flex items-center gap-1 text-xs text-primary font-medium"
                        >
                          {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          {itemLotes.size} {itemLotes.size === 1 ? 'lote' : 'lotes'}
                        </button>
                        {isExpanded && (
                          <div className="mt-1 space-y-1 pl-4">
                            {Array.from(itemLotes.entries()).map(([loteNum, info]) => (
                              <p key={loteNum} className="text-xs text-muted-foreground">
                                Lote <span className="font-mono font-medium text-foreground">{loteNum}</span>
                                {' — '}{info.count} un — val: {formatDate(info.val)}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Divergence button */}
                    {status !== 'conferido' && status !== 'divergencia' && (
                      <Button
                        variant="ghost" size="sm"
                        className="text-xs text-destructive h-7 px-2"
                        onClick={(e) => { e.stopPropagation(); setDivergenciaItemId(item.id); }}
                      >
                        <AlertTriangle className="h-3 w-3 mr-1" /> Reportar Divergência
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </div>

      {/* Finalize button */}
      {canFinalize && (
        <div className="fixed bottom-0 left-0 right-0 z-30 p-4 bg-background border-t border-border">
          <Button
            className={cn(
              'w-full h-14 text-base font-semibold',
              hasDivergencia
                ? 'bg-amber-500 hover:bg-amber-600 text-white'
                : 'bg-green-600 hover:bg-green-700 text-white'
            )}
            onClick={handleFinalize}
            disabled={finalizing}
          >
            {finalizing ? (
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
            ) : hasDivergencia ? (
              <AlertTriangle className="h-5 w-5 mr-2" />
            ) : (
              <CheckCircle2 className="h-5 w-5 mr-2" />
            )}
            {hasDivergencia ? 'Finalizar com Divergência' : 'Finalizar Conferência e Efetivar'}
          </Button>
        </div>
      )}

      {/* ===== SCANNING SHEET ===== */}
      <Sheet open={!!activeItemId} onOpenChange={(open) => { if (!open) setActiveItemId(null); }}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl">
          {activeItem && (
            <div className="space-y-5 pb-4">
              <SheetHeader>
                <SheetTitle className="text-sm text-muted-foreground truncate">
                  {activeItem.descricao_produto}
                </SheetTitle>
              </SheetHeader>

              {/* Big unit counter */}
              <div className="text-center py-2">
                <p className="text-5xl font-black text-foreground leading-none">
                  {currentUnit > activeEsperada ? activeEsperada : currentUnit}
                </p>
                <p className="text-lg text-muted-foreground mt-1">
                  de {activeEsperada} unidades
                </p>
                <Progress
                  value={Math.round((activeConferida / activeEsperada) * 100)}
                  className="h-2 mt-3 max-w-xs mx-auto"
                />
              </div>

              {activeConferida >= activeEsperada ? (
                <div className="text-center py-6">
                  <CheckCircle2 className="h-16 w-16 text-green-500 mx-auto mb-3" />
                  <p className="text-lg font-semibold text-foreground">Todas as unidades conferidas!</p>
                  <Button className="mt-4" onClick={() => setActiveItemId(null)}>Fechar</Button>
                </div>
              ) : (
                <>
                  {/* Action buttons */}
                  {!manualMode && (
                    <div className="space-y-2">
                      <Button
                        className="w-full h-14 text-base gap-3"
                        onClick={() => setScannerOpen(true)}
                      >
                        <ScanLine className="h-5 w-5" />
                        Escanear Etiqueta (OCR)
                      </Button>

                      <Button
                        variant="outline"
                        className="w-full h-12 text-base gap-3"
                        onClick={() => setManualMode(true)}
                      >
                        <Keyboard className="h-5 w-5" />
                        Digitar Manualmente
                      </Button>

                      {lastLote && (
                        <Button
                          variant="secondary"
                          className="w-full h-12 text-base gap-3"
                          onClick={handleRepeatLote}
                        >
                          <Copy className="h-5 w-5" />
                          Mesmo lote ({lastLote.numero_lote})
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Manual form */}
                  {manualMode && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">Número do Lote *</Label>
                        <Input
                          value={lote}
                          onChange={(e) => setLote(e.target.value)}
                          placeholder="Ex: 04540624"
                          className="text-lg h-12"
                          autoFocus
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <Label className="text-sm font-medium">Fabricação</Label>
                          <Input
                            type="date"
                            value={fabricacao}
                            onChange={(e) => setFabricacao(e.target.value)}
                            className="h-12"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-sm font-medium">Validade *</Label>
                          <Input
                            type="date"
                            value={validade}
                            onChange={(e) => setValidade(e.target.value)}
                            className="h-12"
                          />
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          className="flex-1 h-12"
                          onClick={() => { resetScanForm(); setManualMode(false); }}
                        >
                          Voltar
                        </Button>
                        <Button
                          className="flex-1 h-14 text-base font-semibold"
                          disabled={!lote.trim() || !validade || saving}
                          onClick={handleConfirmUnit}
                        >
                          {saving ? <Loader2 className="h-5 w-5 animate-spin mr-2" /> : null}
                          Confirmar Unidade
                        </Button>
                      </div>

                      {lastLote && lote !== lastLote.numero_lote && (
                        <Button
                          variant="ghost" size="sm"
                          className="w-full text-xs"
                          onClick={handleRepeatLote}
                        >
                          <Copy className="h-3 w-3 mr-1" />
                          Usar último lote ({lastLote.numero_lote})
                        </Button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* ===== DIVERGENCE DIALOG ===== */}
      <Dialog open={!!divergenciaItemId} onOpenChange={(open) => { if (!open) setDivergenciaItemId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Reportar Divergência
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label>Descreva o problema</Label>
            <Textarea
              value={divergenciaText}
              onChange={(e) => setDivergenciaText(e.target.value)}
              placeholder="Ex: Faltam 3 unidades, 2 latas danificadas..."
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDivergenciaItemId(null)}>Cancelar</Button>
            <Button
              variant="destructive"
              disabled={!divergenciaText.trim() || saving}
              onClick={handleReportDivergencia}
            >
              Registrar Divergência
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== CT-e DIALOG ===== */}
      <Dialog open={cteModalOpen} onOpenChange={setCteModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Vincular CT-e</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Chave de Acesso (44 dígitos)</Label>
              <Input
                value={cteChave}
                onChange={(e) => setCteChave(e.target.value.replace(/\D/g, '').slice(0, 44))}
                placeholder="00000000000000000000000000000000000000000000"
                maxLength={44}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">{cteChave.length}/44</p>
            </div>
            <div className="space-y-2">
              <Label>ou cole o XML do CT-e</Label>
              <Textarea
                value={cteXml}
                onChange={(e) => setCteXml(e.target.value)}
                placeholder="<cteProc>...</cteProc>"
                rows={4}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCteModalOpen(false)}>Cancelar</Button>
            <Button onClick={handleAddCte} disabled={cteSaving || (cteChave.length !== 44 && !cteXml.trim())}>
              {cteSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Vincular
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
