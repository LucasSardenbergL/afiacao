import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ScanBar, type ScanResult } from '@/components/picking/ScanBar';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Play, CheckCircle2, Factory, PackageMinus, WifiOff, Clock, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { decodeHtmlEntities } from '@/lib/utils';
import { useOfflineMutation } from '@/hooks/useOfflineMutation';
import { registerOfflineHandler } from '@/hooks/useOfflineFlush';
import { subscribeToOfflineQueue } from '@/lib/offline-queue';
import { getDeviceId, nextDeviceSeq } from '@/lib/pcp/device';
import {
  iniciarOP, finalizarOP, registrarConsumo, registrarRefugo,
  type ApontarVars, type ConsumoVars, type RefugoVars,
} from '@/services/pcp-apontamento';

// production_orders + estado_projetado (coluna nova do M1, ainda fora dos types gerados) → cast.
interface OP {
  id: string;
  omie_ordem_numero: string | null;
  product_descricao: string | null;
  product_codigo: string | null;
  quantidade: number;
  unidade: string | null;
  status: string | null;
  estado_projetado: string | null;
}

// Ação discriminada que trafega pela fila offline (um único kind 'pcp.apontar').
type AcaoApontamento =
  | ({ acao: 'iniciar' } & ApontarVars)
  | ({ acao: 'finalizar' } & ApontarVars)
  | ({ acao: 'consumo' } & ConsumoVars)
  | ({ acao: 'refugo' } & RefugoVars);

// Despacha para a RPC certa. Compartilhada entre a mutação online e o handler de drenagem offline.
async function despachar(a: AcaoApontamento): Promise<string> {
  switch (a.acao) {
    case 'iniciar': return iniciarOP(a);
    case 'finalizar': return finalizarOP(a);
    case 'consumo': return registrarConsumo(a);
    case 'refugo': return registrarRefugo(a);
  }
}

const QK = ['pcp-apontamento-ops'] as const;

// estado_projetado (derivado dos eventos pela FSM) → rótulo/estilo. Sufixo _anomalo = revisar.
function estadoInfo(op: OP): { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive'; anomalo: boolean } {
  const e = op.estado_projetado;
  const anomalo = !!e && e.endsWith('_anomalo');
  if (anomalo) return { label: 'Anomalia — revisar', variant: 'destructive', anomalo };
  switch (e) {
    case 'em_producao': return { label: 'Em produção', variant: 'default', anomalo };
    case 'pausada': return { label: 'Pausada', variant: 'outline', anomalo };
    case 'concluida': return { label: 'Concluída', variant: 'secondary', anomalo };
    default: return { label: 'Aguardando', variant: 'outline', anomalo };
  }
}

export default function ProducaoApontamento() {
  const [busca, setBusca] = useState('');
  const [fila, setFila] = useState(0);

  const { data: ops, isLoading, refetch } = useQuery({
    queryKey: QK,
    queryFn: async (): Promise<OP[]> => {
      const { data, error } = await supabase
        .from('production_orders')
        .select('*')
        .in('status', ['pending', 'in_progress'])
        .order('created_at', { ascending: true })
        .limit(80);
      if (error) throw error;
      return (data ?? []) as unknown as OP[];
    },
    refetchInterval: 30000,
  });

  // Drena a fila offline enquanto a tela está aberta; revalida a lista ao drenar.
  useEffect(() => registerOfflineHandler<AcaoApontamento>(
    'pcp.apontar',
    async (v) => { await despachar(v); return true; },
    [QK],
  ), []);

  useEffect(() => subscribeToOfflineQueue(setFila), []);

  const apontar = useOfflineMutation<string, AcaoApontamento>({
    kind: 'pcp.apontar',
    mutationFn: despachar,
  });

  const executar = async (op: OP, montar: (base: ApontarVars) => AcaoApontamento) => {
    const base: ApontarVars = {
      eventId: crypto.randomUUID(),
      opId: op.id,
      deviceId: getDeviceId(),
      deviceSeq: nextDeviceSeq(),
      clientTs: new Date().toISOString(),
    };
    try {
      const estado = await apontar.mutateAsync(montar(base));
      if (estado === null) {
        toast.info('Salvo offline — sincroniza ao reconectar');
      } else {
        toast.success(`OP ${op.omie_ordem_numero ?? op.id.slice(0, 8)}: ${estadoInfo({ ...op, estado_projetado: estado }).label}`);
        refetch();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao apontar');
    }
  };

  const handleScan = (r: ScanResult) => setBusca(r.raw);

  const filtered = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return ops ?? [];
    return (ops ?? []).filter(o =>
      (o.omie_ordem_numero ?? '').toLowerCase().includes(q) ||
      (o.product_codigo ?? '').toLowerCase().includes(q) ||
      (o.product_descricao ?? '').toLowerCase().includes(q),
    );
  }, [ops, busca]);

  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-3">
      <ScanBar onScan={handleScan} placeholder="Bipe ou digite o número da OP / código" />

      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <Factory className="h-5 w-5 text-primary" />
          <h1 className="text-base font-semibold">Apontamento de produção</h1>
        </div>
        {fila > 0 && (
          <Badge variant="outline" className="gap-1 text-status-warning">
            <WifiOff className="h-3.5 w-3.5" />
            {fila} na fila
          </Badge>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">
          <Factory className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
          {busca ? 'Nenhuma OP encontrada.' : 'Nenhuma OP aberta.'}
        </div>
      ) : (
        <ul className="space-y-2 px-1">
          {filtered.map(op => {
            const info = estadoInfo(op);
            const emProducao = op.estado_projetado === 'em_producao' || op.estado_projetado === 'pausada';
            const aguardando = !op.estado_projetado || op.estado_projetado === 'aguardando';
            const concluida = op.estado_projetado === 'concluida';
            return (
              <li key={op.id}>
                <Card>
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">
                          {decodeHtmlEntities(op.product_descricao ?? '') || 'Produto'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {op.omie_ordem_numero ? `OP ${op.omie_ordem_numero} · ` : ''}
                          {op.product_codigo ? `${op.product_codigo} · ` : ''}
                          {op.quantidade} {op.unidade}
                        </p>
                      </div>
                      <Badge variant={info.variant} className="gap-1 shrink-0">
                        {info.anomalo ? <AlertTriangle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                        {info.label}
                      </Badge>
                    </div>

                    <div className="flex flex-wrap gap-2 pt-1">
                      {aguardando && (
                        <Button size="touch" onClick={() => executar(op, b => ({ acao: 'iniciar', ...b }))} disabled={apontar.isPending}>
                          <Play className="h-4 w-4 mr-1.5" /> Iniciar
                        </Button>
                      )}
                      {emProducao && (
                        <>
                          <Button size="touch" onClick={() => executar(op, b => ({ acao: 'finalizar', ...b }))} disabled={apontar.isPending}>
                            <CheckCircle2 className="h-4 w-4 mr-1.5" /> Finalizar
                          </Button>
                          <ConsumoDialog op={op} onConfirm={(c) => executar(op, b => ({ acao: 'consumo', ...b, ...c }))} />
                          <RefugoDialog op={op} onConfirm={(q) => executar(op, b => ({ acao: 'refugo', ...b, quantidade: q }))} />
                        </>
                      )}
                      {concluida && (
                        <span className="text-xs text-status-success inline-flex items-center">
                          <CheckCircle2 className="h-4 w-4 mr-1" /> Concluída
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Dialog de consumo-motivo (resolve a dor do Tingimix: consumo não registrado).
function ConsumoDialog({ op, onConfirm }: { op: OP; onConfirm: (c: Pick<ConsumoVars, 'componenteCodigo' | 'quantidade' | 'unidade' | 'motivo' | 'nota'>) => void }) {
  const [open, setOpen] = useState(false);
  const [codigo, setCodigo] = useState('');
  const [qtd, setQtd] = useState('');
  const [unidade, setUnidade] = useState('G');
  const [motivo, setMotivo] = useState<ConsumoVars['motivo']>('erro_formula');

  const submit = () => {
    const componenteCodigo = Number(codigo);
    const quantidade = Number(qtd.replace(',', '.'));
    if (!Number.isFinite(componenteCodigo) || componenteCodigo <= 0) { toast.error('Código do insumo inválido'); return; }
    if (!Number.isFinite(quantidade) || quantidade <= 0) { toast.error('Quantidade inválida'); return; }
    onConfirm({ componenteCodigo, quantidade, unidade, motivo, nota: null });
    setOpen(false);
    setCodigo(''); setQtd('');
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="touch" variant="outline">
          <PackageMinus className="h-4 w-4 mr-1.5" /> Consumo
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar consumo — OP {op.omie_ordem_numero ?? op.id.slice(0, 8)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="cons-cod">Código do insumo (Omie)</Label>
            <Input id="cons-cod" inputMode="numeric" value={codigo} onChange={e => setCodigo(e.target.value)} placeholder="ex: 900002" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="cons-qtd">Quantidade</Label>
              <Input id="cons-qtd" inputMode="decimal" value={qtd} onChange={e => setQtd(e.target.value)} placeholder="ex: 1,5" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cons-un">Unidade</Label>
              <Input id="cons-un" value={unidade} onChange={e => setUnidade(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Motivo</Label>
            <Select value={motivo} onValueChange={v => setMotivo(v as ConsumoVars['motivo'])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="erro_formula">Erro de fórmula</SelectItem>
                <SelectItem value="teste">Teste/batida</SelectItem>
                <SelectItem value="ajuste">Ajuste</SelectItem>
                <SelectItem value="producao">Produção</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button size="touch" onClick={submit}>Registrar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RefugoDialog({ op, onConfirm }: { op: OP; onConfirm: (qtd: number) => void }) {
  const [open, setOpen] = useState(false);
  const [qtd, setQtd] = useState('');

  const submit = () => {
    const quantidade = Number(qtd.replace(',', '.'));
    if (!Number.isFinite(quantidade) || quantidade <= 0) { toast.error('Quantidade inválida'); return; }
    onConfirm(quantidade);
    setOpen(false);
    setQtd('');
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="touch" variant="ghost">Refugo</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar refugo — OP {op.omie_ordem_numero ?? op.id.slice(0, 8)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="ref-qtd">Quantidade refugada ({op.unidade})</Label>
          <Input id="ref-qtd" inputMode="decimal" value={qtd} onChange={e => setQtd(e.target.value)} placeholder="ex: 2" />
        </div>
        <DialogFooter>
          <Button size="touch" onClick={submit}>Registrar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
