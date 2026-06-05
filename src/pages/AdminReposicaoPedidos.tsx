import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { PedidoSugerido } from '@/components/reposicao/pedidos/types';
import { EMPRESA, interpretarRespostaDisparo, type RespostaDisparo } from '@/components/reposicao/pedidos/shared';
import { CycleIndicator } from '@/components/reposicao/pedidos/CycleIndicator';
import { PedidoRow } from '@/components/reposicao/pedidos/PedidoRow';
import { DetalhesModal } from '@/components/reposicao/pedidos/DetalhesModal';
import { CancelarModal } from '@/components/reposicao/pedidos/CancelarModal';
import { PortalDrawer } from '@/components/reposicao/pedidos/PortalDrawer';
import { CiclosAnteriores } from '@/components/reposicao/pedidos/CiclosAnteriores';

type SkuSemFornecedor = {
  sku_codigo_omie: string;
  sku_descricao: string | null;
  estoque_efetivo: number | null;
  ponto_pedido: number | null;
};

/* ─── Página principal ─── */
export default function AdminReposicaoPedidos() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [now, setNow] = useState(new Date());
  const [detalhesPedido, setDetalhesPedido] = useState<PedidoSugerido | null>(null);
  const [cancelarPedido, setCancelarPedido] = useState<PedidoSugerido | null>(null);
  const [portalPedido, setPortalPedido] = useState<PedidoSugerido | null>(null);
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

  const dispararMutation = useMutation({
    mutationFn: async (pedidoId: number) => {
      const { data, error } = await supabase.functions.invoke('disparar-pedidos-aprovados', {
        body: { empresa: EMPRESA, pedido_id: pedidoId },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data, pedidoId) => {
      const { tone, message } = interpretarRespostaDisparo(data as RespostaDisparo, pedidoId);
      if (tone === 'error') toast.error(message);
      else if (tone === 'info') toast.info(message);
      else toast.success(message);
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
    },
    onError: (e: Error) => {
      toast.error(`Erro ao disparar: ${e.message}`);
    },
  });

  const bloqueados = (pedidos ?? []).filter((p) => p.status === 'bloqueado_guardrail');

  // SKUs abaixo do ponto que NÃO geram pedido por falta de fornecedor cadastrado.
  // A RPC (20260604170000) passou a exigir fornecedor — esses ficavam como
  // cabeçalho-fantasma na fila; agora aparecem aqui, pra não sumirem em silêncio.
  const { data: semFornecedor } = useQuery({
    queryKey: ['reposicao-sku-sem-fornecedor', EMPRESA],
    queryFn: async (): Promise<SkuSemFornecedor[]> => {
      const { data, error } = await supabase
        .from('v_reposicao_sku_sem_fornecedor' as never)
        .select('sku_codigo_omie, sku_descricao, estoque_efetivo, ponto_pedido')
        .eq('empresa', EMPRESA)
        .order('sku_descricao', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as SkuSemFornecedor[];
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

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

      {semFornecedor && semFornecedor.length > 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {semFornecedor.length} SKU{semFornecedor.length > 1 ? 's' : ''} abaixo do ponto sem fornecedor — não entra{semFornecedor.length > 1 ? 'm' : ''} em compra
          </AlertTitle>
          <AlertDescription>
            <p className="mb-2">
              Estão habilitados na reposição e abaixo do ponto de pedido, mas sem fornecedor cadastrado —
              então não geram pedido. Cadastre o fornecedor (Cadastros → Cadeia Logística) para incluí-los:
            </p>
            <ul className="list-disc pl-5 space-y-0.5 text-sm">
              {semFornecedor.slice(0, 10).map((s) => (
                <li key={s.sku_codigo_omie}>
                  {s.sku_descricao ?? s.sku_codigo_omie}
                  <span className="text-muted-foreground font-mono text-xs"> · {s.sku_codigo_omie}</span>
                </li>
              ))}
            </ul>
            {semFornecedor.length > 10 && (
              <p className="mt-1 text-xs text-muted-foreground">+{semFornecedor.length - 10} outro(s)</p>
            )}
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
                      <TableHead>Portal</TableHead>
                      <TableHead>Aprovado em</TableHead>
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
                        onVerPortal={() => setPortalPedido(p)}
                        onDisparar={() => dispararMutation.mutate(p.id)}
                        disparando={dispararMutation.isPending && dispararMutation.variables === p.id}
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
      <PortalDrawer
        pedido={portalPedido}
        open={!!portalPedido}
        onOpenChange={(v) => !v && setPortalPedido(null)}
      />
    </div>
  );
}
