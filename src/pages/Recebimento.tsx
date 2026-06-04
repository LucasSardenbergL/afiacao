import { useState, useEffect } from 'react';
import { decodeHtmlEntities } from '@/lib/utils';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { FileCheck, Truck, Plus, Loader2, PackageCheck, RefreshCw, Stethoscope } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import type { Tables } from '@/integrations/supabase/types';

type NfeStatus = 'pendente' | 'em_conferencia' | 'divergencia' | 'conferido' | 'efetivado' | 'falha_efetivacao' | 'efetivacao_parcial';

type Warehouse = Tables<'warehouses'>;
type NfeRecebimento = Tables<'nfe_recebimentos'>;
type NfeItem = Pick<
  Tables<'nfe_recebimento_itens'>,
  'id' | 'status_item' | 'quantidade_conferida' | 'quantidade_esperada'
>;
type CteAssociado = Pick<Tables<'cte_associados'>, 'id' | 'valor_frete'>;

type NfeWithRelations = NfeRecebimento & {
  nfe_recebimento_itens: NfeItem[] | null;
  cte_associados: CteAssociado[] | null;
};

type NfePendingRow = Pick<NfeRecebimento, 'warehouse_id' | 'status'>;

interface ImportWebhookResponse {
  message?: string;
}

const STATUS_CONFIG: Record<NfeStatus, { label: string; className: string }> = {
  pendente: { label: 'Pendente', className: 'bg-status-warning-bg text-status-warning-foreground' },
  em_conferencia: { label: 'Em Conferência', className: 'bg-status-info-bg text-status-info-foreground' },
  divergencia: { label: 'Divergência', className: 'bg-status-error-bg text-status-error-foreground' },
  conferido: { label: 'Conferido', className: 'bg-status-success-bg text-status-success-foreground' },
  efetivado: { label: 'Efetivado', className: 'bg-muted text-muted-foreground' },
  falha_efetivacao: { label: 'Falha na efetivação', className: 'bg-status-error-bg text-status-error-foreground' },
  efetivacao_parcial: { label: 'Efetivação parcial', className: 'bg-status-warning-bg text-status-warning-foreground' },
};

function formatCurrency(value: number | null) {
  if (value == null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('pt-BR');
}

export default function Recebimento({ statusFilter }: { statusFilter?: string[] } = {}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedWarehouse, setSelectedWarehouse] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [chaveAcesso, setChaveAcesso] = useState('');
  const [importing, setImporting] = useState(false);
  const [efetivando, setEfetivando] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  // A0 — diagnóstico read-only do estado real no Omie (destrava o mapeamento de campos da Fase A1)
  const [diagnosticando, setDiagnosticando] = useState<string | null>(null);
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagResult, setDiagResult] = useState('');
  const [diagTitle, setDiagTitle] = useState('');

  // Fetch warehouses
  const { data: warehouses } = useQuery({
    queryKey: ['warehouses'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('warehouses')
        .select('*')
        .eq('is_active', true)
        .order('code');
      if (error) throw error;
      return data ?? [];
    },
  });

  // Auto-select first warehouse
  useEffect(() => {
    if (warehouses && warehouses.length > 0 && !selectedWarehouse) {
      setSelectedWarehouse(warehouses[0].id);
    }
  }, [warehouses, selectedWarehouse]);

  // Fetch NF-es with item counts
  const { data: nfes, isLoading } = useQuery({
    queryKey: ['nfe_recebimentos', selectedWarehouse, statusFilter],
    queryFn: async () => {
      if (!selectedWarehouse) return [];
      let query = supabase
        .from('nfe_recebimentos')
        .select(`
          *,
          nfe_recebimento_itens(id, status_item, quantidade_conferida, quantidade_esperada),
          cte_associados(id, valor_frete)
        `)
        .eq('warehouse_id', selectedWarehouse);
      if (statusFilter && statusFilter.length > 0) {
        query = query.in('status', statusFilter);
      }
      const { data, error } = await query.order('data_emissao', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as NfeWithRelations[];
    },
    enabled: !!selectedWarehouse,
  });

  // Pending counts per warehouse
  const { data: pendingCounts } = useQuery({
    queryKey: ['nfe_pending_counts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('nfe_recebimentos')
        .select('warehouse_id, status')
        .in('status', ['pendente', 'em_conferencia', 'divergencia']);
      if (error) throw error;
      const counts: Record<string, number> = {};
      (data ?? []).forEach((r: NfePendingRow) => {
        counts[r.warehouse_id] = (counts[r.warehouse_id] || 0) + 1;
      });
      return counts;
    },
  });

  // Realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel('nfe_recebimentos_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'nfe_recebimentos' }, () => {
        queryClient.invalidateQueries({ queryKey: ['nfe_recebimentos'] });
        queryClient.invalidateQueries({ queryKey: ['nfe_pending_counts'] });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);

  const handleCardClick = (nfe: NfeWithRelations) => {
    if (nfe.status === 'pendente' || nfe.status === 'em_conferencia') {
      navigate(`/recebimento/${nfe.id}`);
    }
  };

  const handleEfetivar = async (nfeId: string) => {
    setEfetivando(nfeId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await supabase.functions.invoke('omie-nfe-recebimento', {
        body: { nfe_recebimento_id: nfeId },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (res.error) throw res.error;
      toast.success('NF-e efetivada com sucesso no Omie!');
      queryClient.invalidateQueries({ queryKey: ['nfe_recebimentos'] });
      queryClient.invalidateQueries({ queryKey: ['nfe_pending_counts'] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Erro ao efetivar: ' + (message || 'Tente novamente'));
    } finally {
      setEfetivando(null);
    }
  };

  // Diagnóstico read-only: lê o estado real do recebimento no Omie (ConsultarRecebimento)
  // sem escrever nada. Pro founder me colar o JSON e eu mapear os campos da Fase A1.
  const handleDiagnosticar = async (nfeId: string, numero: string) => {
    setDiagnosticando(nfeId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await supabase.functions.invoke('omie-nfe-recebimento', {
        body: { nfe_recebimento_id: nfeId, diagnostico: true },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (res.error) throw res.error;
      setDiagTitle(`Diagnóstico — NF-e ${numero}`);
      setDiagResult(JSON.stringify(res.data, null, 2));
      setDiagOpen(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Erro no diagnóstico: ' + (message || 'Tente novamente'));
    } finally {
      setDiagnosticando(null);
    }
  };

  const handleImport = async () => {
    const clean = chaveAcesso.replace(/\s/g, '');
    if (clean.length !== 44) {
      toast.error('A chave de acesso deve ter 44 dígitos');
      return;
    }
    setImporting(true);
    try {
      const res = await supabase.functions.invoke('omie-nfe-webhook', {
        body: { chave_acesso: clean },
      });
      if (res.error) throw res.error;
      const responseData = res.data as ImportWebhookResponse | null;
      if (responseData?.message === 'já importada') {
        toast.info('Esta NF-e já foi importada');
      } else {
        toast.success('NF-e importada com sucesso!');
      }
      setImportOpen(false);
      setChaveAcesso('');
      queryClient.invalidateQueries({ queryKey: ['nfe_recebimentos'] });
      queryClient.invalidateQueries({ queryKey: ['nfe_pending_counts'] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Erro ao importar: ' + (message || 'Verifique a chave'));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileCheck className="h-6 w-6 text-primary" />
          <h1 className="text-xl font-bold text-foreground">Recebimento de NF-e</h1>
        </div>
        <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="hidden lg:inline-flex"
          onClick={() => setImportOpen(true)}
        >
          <Plus className="h-4 w-4 mr-1" />
          Importar NF-e
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            try {
              const { error } = await supabase.functions.invoke('omie-nfe-recebimento-sync', { body: {} });
              if (error) throw error;
              toast.success('Sincronização concluída!');
              queryClient.invalidateQueries({ queryKey: ['nfe_recebimentos'] });
              queryClient.invalidateQueries({ queryKey: ['nfe_pending_counts'] });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              toast.error('Erro na sincronização: ' + (message || 'Tente novamente'));
            } finally {
              setSyncing(false);
            }
          }}
        >
          <RefreshCw className={cn('h-4 w-4 mr-1', syncing && 'animate-spin')} />
          Sincronizar Omie
        </Button>
        </div>
      </div>

      {/* Warehouse selector */}
      <div className="flex gap-2">
        {(warehouses ?? []).map((wh: Warehouse) => {
          const count = pendingCounts?.[wh.id] ?? 0;
          const isSelected = selectedWarehouse === wh.id;
          return (
            <button
              key={wh.id}
              onClick={() => setSelectedWarehouse(wh.id)}
              className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors',
                isSelected
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card text-foreground border-border hover:bg-accent'
              )}
            >
              {wh.name} ({wh.code})
              {count > 0 && (
                <Badge variant="secondary" className={cn(
                  'text-xs',
                  isSelected ? 'bg-primary-foreground/20 text-primary-foreground' : ''
                )}>
                  {count}
                </Badge>
              )}
            </button>
          );
        })}
      </div>

      {/* NF-e list */}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !nfes || nfes.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={PackageCheck}
              title="Nenhuma NF-e neste armazém"
              description="Novas NF-es aparecerão aqui automaticamente via webhook do Omie. Você também pode forçar processamento manual."
              actionLabel="Processar NF-e manualmente"
              onAction={() => navigate('/nfe-receipt')}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {nfes.map((nfe: NfeWithRelations) => {
            const itens: NfeItem[] = nfe.nfe_recebimento_itens ?? [];
            const totalItens = itens.length;
            const conferidos = itens.filter((i: NfeItem) => i.status_item === 'conferido').length;
            const ctes: CteAssociado[] = nfe.cte_associados ?? [];
            const totalFrete = ctes.reduce((s: number, c: CteAssociado) => s + (c.valor_frete ?? 0), 0);
            const status = nfe.status as NfeStatus;
            const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.pendente;

            const isClickable = status === 'pendente' || status === 'em_conferencia';
            const isConferido = status === 'conferido';

            return (
              <Card
                key={nfe.id}
                className={cn(
                  'transition-colors',
                  isClickable && 'cursor-pointer hover:border-primary/50'
                )}
                onClick={() => isClickable && handleCardClick(nfe)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0 space-y-1">
                      {/* Row 1: NF-e number + status */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-foreground">
                          NF-e {nfe.numero_nfe}
                        </span>
                        {nfe.serie_nfe && (
                          <span className="text-xs text-muted-foreground">Série {nfe.serie_nfe}</span>
                        )}
                        <Badge className={cn('text-xs', config.className)}>
                          {config.label}
                        </Badge>
                      </div>

                      {/* Row 2: Supplier */}
                      <p className="text-sm text-muted-foreground truncate">
                        {decodeHtmlEntities(nfe.razao_social_emitente) || 'Fornecedor não identificado'}
                      </p>

                      {/* Row 3: Details */}
                      <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                        <span>{formatDate(nfe.data_emissao)}</span>
                        <span className="font-medium text-foreground">{formatCurrency(nfe.valor_total)}</span>
                        <span>{totalItens} {totalItens === 1 ? 'item' : 'itens'}</span>
                        {totalItens > 0 && (
                          <span className={cn(
                            conferidos === totalItens ? 'text-status-success' : 'text-status-warning'
                          )}>
                            {conferidos} de {totalItens} conferidos
                          </span>
                        )}
                        {ctes.length > 0 && (
                          <span className="flex items-center gap-1">
                            <Truck className="h-3 w-3" />
                            {formatCurrency(totalFrete)}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Ações */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {/* Diagnosticar (read-only) — disponível assim que houver vínculo Omie */}
                      {nfe.omie_id_receb != null && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => { e.stopPropagation(); handleDiagnosticar(nfe.id, nfe.numero_nfe); }}
                          disabled={diagnosticando === nfe.id}
                          title="Diagnosticar no Omie (read-only)"
                          aria-label="Diagnosticar no Omie"
                        >
                          {diagnosticando === nfe.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Stethoscope className="h-4 w-4" />
                          )}
                        </Button>
                      )}
                      {isConferido && (
                        <Button
                          size="sm"
                          onClick={(e) => { e.stopPropagation(); handleEfetivar(nfe.id); }}
                          disabled={efetivando === nfe.id}
                        >
                          {efetivando === nfe.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            'Efetivar'
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* FAB - Import manual */}
      <button
        onClick={() => setImportOpen(true)}
        className="fixed bottom-6 right-6 z-40 h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-lg flex lg:hidden items-center justify-center hover:bg-primary/90 transition-colors"
        aria-label="Importar NF-e"
      >
        <Plus className="h-6 w-6" />
      </button>

      {/* Import dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Importar NF-e por Chave de Acesso</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="chave">Chave de Acesso (44 dígitos)</Label>
            <Input
              id="chave"
              value={chaveAcesso}
              onChange={(e) => setChaveAcesso(e.target.value.replace(/\D/g, '').slice(0, 44))}
              placeholder="00000000000000000000000000000000000000000000"
              maxLength={44}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {chaveAcesso.length}/44 dígitos
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>Cancelar</Button>
            <Button onClick={handleImport} disabled={importing || chaveAcesso.length !== 44}>
              {importing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Importar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Diagnóstico read-only do Omie (Fase A0) */}
      <Dialog open={diagOpen} onOpenChange={setDiagOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{diagTitle}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <p className="text-xs text-muted-foreground">
              Estado real do recebimento no Omie (read-only — nada foi escrito). Copie e cole pra mapear os campos da efetivação completa.
            </p>
            <pre className="text-xs bg-muted rounded p-3 max-h-[50vh] overflow-auto font-mono whitespace-pre-wrap break-words">
              {diagResult}
            </pre>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { navigator.clipboard?.writeText(diagResult); toast.success('JSON copiado'); }}
            >
              Copiar JSON
            </Button>
            <Button onClick={() => setDiagOpen(false)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
