import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { FileCheck, Truck, Plus, Loader2, PackageCheck, RefreshCw } from 'lucide-react';
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

type NfeStatus = 'pendente' | 'em_conferencia' | 'divergencia' | 'conferido' | 'efetivado';

const STATUS_CONFIG: Record<NfeStatus, { label: string; className: string }> = {
  pendente: { label: 'Pendente', className: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200' },
  em_conferencia: { label: 'Em Conferência', className: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' },
  divergencia: { label: 'Divergência', className: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' },
  conferido: { label: 'Conferido', className: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' },
  efetivado: { label: 'Efetivado', className: 'bg-muted text-muted-foreground' },
};

function formatCurrency(value: number | null) {
  if (value == null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('pt-BR');
}

export default function Recebimento() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedWarehouse, setSelectedWarehouse] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [chaveAcesso, setChaveAcesso] = useState('');
  const [importing, setImporting] = useState(false);
  const [efetivando, setEfetivando] = useState<string | null>(null);

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
    queryKey: ['nfe_recebimentos', selectedWarehouse],
    queryFn: async () => {
      if (!selectedWarehouse) return [];
      const { data, error } = await supabase
        .from('nfe_recebimentos')
        .select(`
          *,
          nfe_recebimento_itens(id, status_item, quantidade_conferida, quantidade_esperada),
          cte_associados(id, valor_frete)
        `)
        .eq('warehouse_id', selectedWarehouse)
        .order('data_emissao', { ascending: true });
      if (error) throw error;
      return data ?? [];
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
      (data ?? []).forEach((r: any) => {
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

  const handleCardClick = (nfe: any) => {
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
    } catch (err: any) {
      toast.error('Erro ao efetivar: ' + (err.message || 'Tente novamente'));
    } finally {
      setEfetivando(null);
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
      if (res.data?.message === 'já importada') {
        toast.info('Esta NF-e já foi importada');
      } else {
        toast.success('NF-e importada com sucesso!');
      }
      setImportOpen(false);
      setChaveAcesso('');
      queryClient.invalidateQueries({ queryKey: ['nfe_recebimentos'] });
      queryClient.invalidateQueries({ queryKey: ['nfe_pending_counts'] });
    } catch (err: any) {
      toast.error('Erro ao importar: ' + (err.message || 'Verifique a chave'));
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
      </div>

      {/* Warehouse selector */}
      <div className="flex gap-2">
        {(warehouses ?? []).map((wh: any) => {
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
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : !nfes || nfes.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <PackageCheck className="h-12 w-12 mx-auto mb-3 opacity-40" />
            <p className="text-lg font-medium">Nenhuma NF-e neste armazém</p>
            <p className="text-sm mt-1">Novas NF-es aparecerão automaticamente via webhook</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {nfes.map((nfe: any) => {
            const itens = nfe.nfe_recebimento_itens ?? [];
            const totalItens = itens.length;
            const conferidos = itens.filter((i: any) => i.status_item === 'conferido').length;
            const ctes = nfe.cte_associados ?? [];
            const totalFrete = ctes.reduce((s: number, c: any) => s + (c.valor_frete ?? 0), 0);
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
                        {nfe.razao_social_emitente || 'Fornecedor não identificado'}
                      </p>

                      {/* Row 3: Details */}
                      <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                        <span>{formatDate(nfe.data_emissao)}</span>
                        <span className="font-medium text-foreground">{formatCurrency(nfe.valor_total)}</span>
                        <span>{totalItens} {totalItens === 1 ? 'item' : 'itens'}</span>
                        {totalItens > 0 && (
                          <span className={cn(
                            conferidos === totalItens ? 'text-green-600' : 'text-amber-600'
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

                    {/* Efetivar button */}
                    {isConferido && (
                      <Button
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); handleEfetivar(nfe.id); }}
                        disabled={efetivando === nfe.id}
                        className="shrink-0"
                      >
                        {efetivando === nfe.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          'Efetivar'
                        )}
                      </Button>
                    )}
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
        className="fixed bottom-6 right-6 z-40 h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:bg-primary/90 transition-colors"
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
    </div>
  );
}
