import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertTriangle, CheckCircle2, Eye, Loader2, RefreshCw, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { PedidoSugerido } from '@/components/reposicao/pedidos/types';
import { EMPRESA, formatBRL, interpretarRespostaDisparo, pedidosVisiveis, type RespostaDisparo } from '@/components/reposicao/pedidos/shared';
import { CycleIndicator } from '@/components/reposicao/pedidos/CycleIndicator';
import { PedidoRow } from '@/components/reposicao/pedidos/PedidoRow';
import { StatusComMotivo, PortalBadge } from '@/components/reposicao/pedidos/badges';
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
  const [mostrarAtencao, setMostrarAtencao] = useState(false);

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

  // Fila CROSS-CICLO de "precisa de atenção": pedidos que exigem ação humana em
  // QUALQUER ciclo (a lista de hoje não pega travado de ciclo passado). Critério
  // espelha pedidoPrecisaAtencao() de shared.ts. Os valores do .or() são literais
  // estáticos (sem interpolação) → seguro e lint-clean. Filtramos cancelados, que
  // por construção não precisam mais de ação.
  // Key sob o prefixo 'pedidos-ciclo' de propósito: todo mutation da tela invalida
  // ['pedidos-ciclo'] (disparo/conciliação/aprovação) e o React Query casa por prefixo
  // → a fila de atenção se atualiza junto, sem precisar editar cada componente filho.
  const { data: atencao } = useQuery({
    queryKey: ['pedidos-ciclo', 'atencao', EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pedido_compra_sugerido')
        .select('*')
        .eq('empresa', EMPRESA)
        .or(
          'status.eq.falha_envio,status_envio_portal.in.(aceito_portal_sem_protocolo,indeterminado_requer_conciliacao,falha_envio_portal,erro_nao_retentavel)',
        )
        .order('data_ciclo', { ascending: false })
        .order('fornecedor_nome', { ascending: true });
      if (error) throw error;
      // Defesa em profundidade: re-filtra cancelados (caso um caia num estado de
      // portal de atenção residual depois de cancelado).
      return (data ?? []).filter(
        (p) => p.status !== 'cancelado' && p.status !== 'cancelado_humano',
      ) as PedidoSugerido[];
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // Lista "ciclo de hoje" exibida: esconde os pais de split (status='split_em_filhos').
  // O pai não tem ação útil e seu valor_total é a SOMA dos filhos → exibi-lo junto dos
  // filhos dobraria o "valor do ciclo". Os filhos (status normal) seguem visíveis.
  // Usar essa lista derivada tanto no render quanto no contador (consistente).
  const pedidosCiclo = pedidosVisiveis(pedidos ?? []);

  // A fila de atenção é cross-ciclo; o pai split (status='split_em_filhos') por
  // construção nunca entra (pedidoPrecisaAtencao só dispara em falha_envio/portal),
  // mas filtramos por defesa em profundidade — coerente com o render do ciclo.
  const atencaoVisivel = pedidosVisiveis(atencao ?? []);
  const atencaoCount = atencaoVisivel.length;

  // Deep link cross-ciclo: aceita ?id=N (ou ?pedido=N como alias usado por links do
  // portal). Se o pedido não está na lista de hoje, busca o pedido único por id.
  const idParamRaw = searchParams.get('id') ?? searchParams.get('pedido');
  const idNum = idParamRaw !== null && idParamRaw !== '' ? Number(idParamRaw) : NaN;
  const deepLinkId = Number.isInteger(idNum) && idNum > 0 ? idNum : null;

  const limparDeepLink = () => {
    if (searchParams.has('id') || searchParams.has('pedido')) {
      const next = new URLSearchParams(searchParams);
      next.delete('id');
      next.delete('pedido');
      setSearchParams(next, { replace: true });
    }
  };

  // O pedido do deep-link pode já estar carregado (lista de hoje ou fila de atenção).
  const pedidoLocalDoLink =
    deepLinkId !== null
      ? (pedidos ?? []).find((p) => p.id === deepLinkId) ??
        (atencao ?? []).find((p) => p.id === deepLinkId) ??
        null
      : null;

  // Fallback: busca o pedido único por id (empresa-scoped) quando não está local.
  // Só dispara quando o id é válido, ainda não está aberto e não foi achado local.
  const precisaBuscarPorId =
    deepLinkId !== null && detalhesPedido?.id !== deepLinkId && !pedidoLocalDoLink;

  const { data: pedidoPorId, isLoading: carregandoPedidoPorId } = useQuery({
    queryKey: ['pedido-por-id', deepLinkId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pedido_compra_sugerido')
        .select('*')
        .eq('empresa', EMPRESA)
        .eq('id', deepLinkId!)
        .maybeSingle();
      if (error) throw error;
      return (data as PedidoSugerido | null) ?? null;
    },
    enabled: precisaBuscarPorId,
    staleTime: 15_000,
  });

  useEffect(() => {
    if (deepLinkId === null) return;
    if (detalhesPedido?.id === deepLinkId) return;
    // 1) já carregado localmente → abre na hora
    if (pedidoLocalDoLink) {
      setDetalhesPedido(pedidoLocalDoLink);
      return;
    }
    // 2) buscando por id → espera resolver
    if (carregandoPedidoPorId) return;
    if (pedidoPorId) {
      setDetalhesPedido(pedidoPorId);
    } else {
      // id válido mas inexistente nessa empresa → limpa o param
      toast.error(`Pedido #${deepLinkId} não encontrado`);
      limparDeepLink();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkId, pedidoLocalDoLink, pedidoPorId, carregandoPedidoPorId, detalhesPedido?.id]);

  const handleCloseDetalhes = (open: boolean) => {
    if (!open) {
      setDetalhesPedido(null);
      limparDeepLink();
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
        <div className="flex flex-wrap items-center gap-2">
          {atencaoCount > 0 ? (
            <Button
              variant="outline"
              onClick={() => setMostrarAtencao((v) => !v)}
              aria-pressed={mostrarAtencao}
              className="border-status-warning/40 bg-status-warning/10 text-status-warning hover:bg-status-warning/20 hover:text-status-warning"
            >
              <AlertTriangle className="w-4 h-4 mr-1" />
              {atencaoCount} precisa{atencaoCount > 1 ? 'm' : ''} de atenção
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-status-success">
              <CheckCircle2 className="w-3.5 h-3.5" /> Tudo em dia
            </span>
          )}
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

      {mostrarAtencao && atencaoCount > 0 && (
        <Card className="border-status-warning/40">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-status-warning" />
              Precisam de atenção ({atencaoCount}) — todos os ciclos
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Pedidos travados que exigem ação humana (falha no Omie, conciliação do portal ou
              falha definitiva), de qualquer ciclo. Abra os detalhes para resolver — a conciliação
              do portal está em "Ver portal".
            </p>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ciclo</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Fornecedor / Grupo</TableHead>
                  <TableHead className="text-right">Nº SKUs</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead>Portal</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {atencaoVisivel.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="text-xs tabular-nums whitespace-nowrap">
                      {format(new Date(p.data_ciclo + 'T12:00:00'), 'dd/MM/yyyy')}
                    </TableCell>
                    <TableCell>
                      <StatusComMotivo pedido={p} />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{p.fornecedor_nome}</div>
                      <div className="text-xs text-muted-foreground">{p.grupo_codigo ?? '—'}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.num_skus}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{formatBRL(p.valor_total)}</TableCell>
                    <TableCell>
                      <PortalBadge pedido={p} onClick={() => setPortalPedido(p)} />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setDetalhesPedido(p)}>
                          <Eye className="w-4 h-4 mr-1" />Detalhes
                        </Button>
                        {(p.status === 'aprovado_aguardando_disparo' || p.status === 'falha_envio') && (
                          <Button
                            size="sm"
                            variant={p.status === 'falha_envio' ? 'outline' : 'default'}
                            onClick={() => dispararMutation.mutate(p.id)}
                            disabled={
                              (dispararMutation.isPending && dispararMutation.variables === p.id) ||
                              p.status_envio_portal === 'enviando_portal'
                            }
                          >
                            {(dispararMutation.isPending && dispararMutation.variables === p.id) ||
                            p.status_envio_portal === 'enviando_portal' ? (
                              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                            ) : (
                              <Zap className="w-4 h-4 mr-1" />
                            )}
                            {p.status === 'falha_envio' ? 'Re-disparar' : 'Disparar'}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="hoje">
        <TabsList>
          <TabsTrigger value="hoje">Ciclo de hoje</TabsTrigger>
          <TabsTrigger value="historico">Ciclos anteriores</TabsTrigger>
        </TabsList>

        <TabsContent value="hoje">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pedidos do dia ({pedidosCiclo.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : pedidosCiclo.length === 0 ? (
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
                    {pedidosCiclo.map((p) => (
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
