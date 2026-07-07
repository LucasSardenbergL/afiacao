import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Clock, CloudDownload, Eye, Loader2, Zap } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { PedidoSugerido } from '@/components/reposicao/pedidos/types';
import { EMPRESA, edgeSyncOk, formatBRL, frescorEstoque, interpretarRespostaDisparo, particionarCicloHoje, pedidosVisiveis, resumoSyncRecalc, type RespostaDisparo } from '@/components/reposicao/pedidos/shared';
import { CycleIndicator } from '@/components/reposicao/pedidos/CycleIndicator';
import { PedidoRow } from '@/components/reposicao/pedidos/PedidoRow';
import { StatusComMotivo, PortalBadge } from '@/components/reposicao/pedidos/badges';
import { DetalhesModal } from '@/components/reposicao/pedidos/DetalhesModal';
import { CancelarModal } from '@/components/reposicao/pedidos/CancelarModal';
import { PortalDrawer } from '@/components/reposicao/pedidos/PortalDrawer';
import { CiclosAnteriores } from '@/components/reposicao/pedidos/CiclosAnteriores';
import { OverrideMinimoButton } from '@/components/reposicao/pedidos/OverrideMinimoButton';
import { ehGateMinimoFaturamento } from '@/components/reposicao/pedidos/shared';
import { useAuth } from '@/contexts/AuthContext';
import { track } from '@/lib/analytics';

type SkuSemFornecedor = {
  sku_codigo_omie: string;
  sku_descricao: string | null;
  estoque_efetivo: number | null;
  ponto_pedido: number | null;
};

/* ─── Relógio isolado ───
 * O tick de minuto vivia como state da PÁGINA: a cada 60s o setNow re-renderizava
 * a árvore inteira (~500 linhas de pedidos) só pra atualizar data/ciclo/frescor no
 * header. Isolado aqui, cada tick re-renderiza apenas estes componentes minúsculos. */
function useNowMinuto() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function DataDeHojeLive() {
  const now = useNowMinuto();
  return <>{format(now, 'dd/MM/yyyy', { locale: ptBR })}</>;
}

function CycleIndicatorLive() {
  const now = useNowMinuto();
  return <CycleIndicator now={now} />;
}

function FrescorEstoqueLive({ ultimaSync }: { ultimaSync: string | null | undefined }) {
  const now = useNowMinuto();
  const frescor = frescorEstoque(ultimaSync, now);
  const cor = { ok: 'text-muted-foreground', warning: 'text-status-warning', error: 'text-status-error' }[frescor.tone];
  // Horário exato VISÍVEL no texto (dd/MM HH:mm) + segundos no tooltip — o "há X" arredonda e
  // deixava o founder na dúvida do minuto certo.
  const d = ultimaSync ? new Date(ultimaSync) : null;
  const quando = d && !Number.isNaN(d.getTime()) ? format(d, 'dd/MM HH:mm', { locale: ptBR }) : null;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${cor}`}
      title={d && quando ? `Sincronizado ${format(d, "dd/MM 'às' HH:mm:ss", { locale: ptBR })}` : undefined}
    >
      <Clock className="w-3.5 h-3.5" /> Estoque Omie: {frescor.label}{quando ? ` · ${quando}` : ''}
    </span>
  );
}

/* ─── Página principal ─── */
export default function AdminReposicaoPedidos() {
  const queryClient = useQueryClient();
  // Override do mínimo de faturamento é privilegiado: só gestor comercial/master. A tela é
  // RequireStaff (employee|master), então gateamos o botão aqui (o edge reforça no servidor).
  const { isMaster, isGestorComercial } = useAuth();
  const podeOverride = isMaster || isGestorComercial;
  const [searchParams, setSearchParams] = useSearchParams();
  const [detalhesPedido, setDetalhesPedido] = useState<PedidoSugerido | null>(null);
  const [cancelarPedido, setCancelarPedido] = useState<PedidoSugerido | null>(null);
  const [portalPedido, setPortalPedido] = useState<PedidoSugerido | null>(null);
  const [historicoData, setHistoricoData] = useState<string>(() => format(new Date(), 'yyyy-MM-dd'));
  const [mostrarAtencao, setMostrarAtencao] = useState(false);
  const [histAberto, setHistAberto] = useState(false);

  // Vira a queryKey na meia-noite SEM re-render por minuto: setState com a MESMA
  // string faz o React pular o re-render (bailout) nos outros 1.439 ticks do dia.
  // O relógio visual do header vive nos componentes *Live acima, isolados.
  const [dataHoje, setDataHoje] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  useEffect(() => {
    const t = setInterval(() => {
      const novaData = format(new Date(), 'yyyy-MM-dd');
      setDataHoje((atual) => (atual === novaData ? atual : novaData));
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  const { data: pedidos, isLoading } = useQuery({
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

  // Separa os pedidos do dia em ativos (lista principal) e terminais (Histórico de hoje,
  // recolhido). Os terminais — cancelado/cancelado_humano/expirado_sem_aprovacao — são o
  // "lixo do dia" que a geração não varre; tirá-los da lista principal limpa a poluição
  // sem apagar nada do banco.
  const { ativos, historico } = particionarCicloHoje(pedidosCiclo);

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

  // [GATE estoque-não-confirmado] fila de exceção PÓS-geração: o que o motor EFETIVAMENTE suprimiu, gravado em
  // reposicao_estoque_nao_confirmado_log pela RPC. O preflight acima é preditivo (antes do Recalcular); esta é a
  // verdade do último ciclo — sem ela o gate suprime no escuro e vira subcompra invisível (Codex consult 019f0a38).
  // count exato p/ o total 24h (honesto mesmo com a lista capada em 500); a lista cobre folgado 1 run (OBEN ~64).
  // Key sob 'pedidos-ciclo' de propósito: syncRecalcMutation invalida ['pedidos-ciclo'] → re-busca após recalcular.
  const { data: suprimidos } = useQuery({
    queryKey: ['pedidos-ciclo', 'estoque-nao-confirmado-log', EMPRESA],
    queryFn: async () => {
      const desde = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data, count, error } = await supabase
        .from('reposicao_estoque_nao_confirmado_log')
        .select('sku_codigo_omie, sku_descricao, motivo, grupo_codigo, criado_em, run_id', { count: 'exact' })
        .eq('empresa', EMPRESA)
        .gte('criado_em', desde)
        .order('criado_em', { ascending: false })
        .limit(500);
      if (error) throw error;
      return { linhas: data ?? [], total24h: count ?? 0 };
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Frescor do snapshot que o Recalcular usa (max ultima_sincronizacao da empresa).
  // isSuccess evita o flash de "nunca sincronizado" enquanto a query carrega.
  const { data: ultimaSyncEstoque, isSuccess: frescorCarregado } = useQuery({
    queryKey: ['estoque-frescor', EMPRESA],
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from('sku_estoque_atual')
        .select('ultima_sincronizacao')
        .eq('empresa', EMPRESA)
        .order('ultima_sincronizacao', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data?.ultima_sincronizacao ?? null;
    },
    refetchInterval: 60_000,
  });

  // ÚNICO botão de ação da tela — "Sincronizar e recalcular": SALDO (omie-sync-estoque) + STATUS
  // ativo/inativo (omie-sync-status-produtos) em paralelo e, SÓ SE ambas deram certo, recalcula o
  // ciclo (RPC gerar_pedidos_sugeridos_ciclo). Consolidou os 3 botões antigos (sincronizar / atualizar
  // lista / recalcular) num só, a pedido do founder — a lista tem refetchInterval 30s (atualiza
  // sozinha). Se uma sync falhar, NÃO recalcula (regenerar com saldo/status velho = pedido errado,
  // money-path); o resumoSyncRecalc reporta e o usuário reexecuta. Idempotente. ~1–2 min.
  const syncRecalcMutation = useMutation({
    mutationFn: async () => {
      const [estoque, status] = await Promise.allSettled([
        supabase.functions.invoke('omie-sync-estoque', { body: { empresa: EMPRESA } }),
        supabase.functions.invoke('omie-sync-status-produtos', { body: { empresa: EMPRESA } }),
      ]);
      // edgeSyncOk exige invoke-ok E corpo {ok:true} — HTTP 200 com {ok:false} da edge NÃO é sucesso.
      const estoqueOk = edgeSyncOk(estoque);
      const statusOk = edgeSyncOk(status);
      let recalc: { ok: boolean; pedidos: number; erro?: string } | null = null;
      if (estoqueOk && statusOk) {
        const { data, error } = await supabase.rpc('gerar_pedidos_sugeridos_ciclo', {
          p_empresa: EMPRESA,
          p_data_ciclo: dataHoje,
        });
        if (error) {
          // Preserva o motivo (lock/permissão/timeout) — o toast e a telemetria não achatam (Codex).
          recalc = { ok: false, pedidos: 0, erro: error.message };
        } else {
          const r = Array.isArray(data) ? data[0] : data;
          const n = Number(r?.pedidos_gerados);
          recalc = { ok: true, pedidos: Number.isFinite(n) ? n : 0 };
        }
      }
      return { estoqueOk, statusOk, recalc };
    },
    onSuccess: ({ estoqueOk, statusOk, recalc }) => {
      const { tone, message } = resumoSyncRecalc(estoqueOk, statusOk, recalc);
      if (tone === 'error') toast.error(message);
      else if (tone === 'warning') toast.warning(message);
      else toast.success(message);
      track('reposicao.sync_recalc_manual', { empresa: EMPRESA, estoqueOk, statusOk, recalculou: recalc?.ok ?? false });
      queryClient.invalidateQueries({ queryKey: ['estoque-frescor'] });
      queryClient.invalidateQueries({ queryKey: ['estoque-nao-confirmado'] });
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
      queryClient.invalidateQueries({ queryKey: ['pedido-itens'] });
    },
    onError: (e: Error) => {
      track('reposicao.sync_recalc_manual', { empresa: EMPRESA, estoqueOk: false, statusOk: false, recalculou: false });
      toast.error(`Erro ao sincronizar Omie: ${e.message}`);
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

  // Override do gate de mínimo de faturamento (gestor/master). Mesma edge, com ignorar_minimo.
  // Separada da dispararMutation pra não confundir o estado de loading por linha; o edge
  // reforça gestor/master no servidor (403 se não autorizado → cai no onError).
  const dispararOverrideMutation = useMutation({
    mutationFn: async (pedidoId: number) => {
      const { data, error } = await supabase.functions.invoke('disparar-pedidos-aprovados', {
        body: { empresa: EMPRESA, pedido_id: pedidoId, ignorar_minimo: true },
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

  // Estado de disparo por linha cobre AMBAS as mutações (normal + override) — o botão da
  // linha trava enquanto qualquer disparo daquele pedido está em voo.
  const disparandoLinha = (pedidoId: number) =>
    (dispararMutation.isPending && dispararMutation.variables === pedidoId) ||
    (dispararOverrideMutation.isPending && dispararOverrideMutation.variables === pedidoId);

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

  // [GATE estoque-não-confirmado] suprimidos do ÚLTIMO recálculo (reflete os pedidos na tela) + contexto 24h
  // (crônico?). supLinhas vem ordenado por criado_em desc → [0] é o run mais recente; filtra esse run_id.
  const supLinhas = suprimidos?.linhas ?? [];
  const ultimoRunId = supLinhas[0]?.run_id ?? null;
  const supUltimoRun = ultimoRunId ? supLinhas.filter((s) => s.run_id === ultimoRunId) : [];
  const supLinhaQtd = supUltimoRun.filter((s) => s.motivo === 'linha_seed_only').length;
  const supGrupoQtd = supUltimoRun.filter((s) => s.motivo === 'grupo_membro_seed_only').length;
  const supTotal24h = suprimidos?.total24h ?? 0;
  const ultimoSupEm = supLinhas[0]?.criado_em ?? null;

  // Telemetria: quantos o gate suprimiu por recálculo — detecta sync cronicamente atrasado (Codex consult
  // 019f0a38). A ref garante 1 disparo por run distinto mesmo com o effect reativo a todas as deps (lint-clean).
  const runTelemetradoRef = useRef<string | null>(null);
  useEffect(() => {
    if (supUltimoRun.length > 0 && ultimoRunId && runTelemetradoRef.current !== ultimoRunId) {
      runTelemetradoRef.current = ultimoRunId;
      track('reposicao.gate_estoque_nao_confirmado', {
        empresa: EMPRESA,
        run_id: ultimoRunId,
        suprimidos_ultimo_run: supUltimoRun.length,
        por_linha: supLinhaQtd,
        por_grupo: supGrupoQtd,
        total_24h: supTotal24h,
      });
    }
  }, [ultimoRunId, supUltimoRun.length, supLinhaQtd, supGrupoQtd, supTotal24h]);

  return (
    <div className="container mx-auto py-6 space-y-6 max-w-7xl">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Pedidos de compra — CICLO DE HOJE (<DataDeHojeLive />)
          </h1>
          <div className="mt-2"><CycleIndicatorLive /></div>
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
          {frescorCarregado && <FrescorEstoqueLive ultimaSync={ultimaSyncEstoque} />}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                disabled={syncRecalcMutation.isPending}
                title="Puxa do Omie o saldo E o status ativo/inativo dos produtos (~1–2 min) e recalcula as sugestões de hoje."
              >
                {syncRecalcMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <CloudDownload className="w-4 h-4 mr-1" />}
                {syncRecalcMutation.isPending ? 'Sincronizando…' : 'Sincronizar e recalcular'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Sincronizar Omie e recalcular?</AlertDialogTitle>
                <AlertDialogDescription>
                  Puxa do Omie o saldo e o status ativo/inativo dos produtos (~1–2 min) e recalcula as
                  sugestões de hoje — remove itens inativados e usa o estoque atualizado. Regenera os
                  pedidos pendentes ainda não aprovados; se você já ajustou algum item manualmente,
                  refaça o ajuste depois.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Voltar</AlertDialogCancel>
                <AlertDialogAction
                  disabled={syncRecalcMutation.isPending}
                  onClick={() => syncRecalcMutation.mutate()}
                >
                  Sincronizar e recalcular
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
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

      {supUltimoRun.length > 0 && (
        <Alert className="border-status-warning/40 bg-status-warning/5">
          <AlertTriangle className="h-4 w-4 text-status-warning" />
          <AlertTitle className="text-status-warning">
            {supUltimoRun.length} SKU{supUltimoRun.length > 1 ? 's' : ''} fora da compra — estoque não confirmado pelo sync
          </AlertTitle>
          <AlertDescription>
            <p className="mb-1">
              No último recálculo{ultimoSupEm ? ` (${format(new Date(ultimoSupEm), "dd/MM 'às' HH:mm", { locale: ptBR })})` : ''} o
              motor <strong>pulou</strong> estes SKUs: o estoque vinha só do cold-start (catálogo), sem confirmação do
              ListarPosEstoque — comprar por cima seria capital empatado.
            </p>
            {(supLinhaQtd > 0 || supGrupoQtd > 0) && (
              <p className="mb-2 text-xs text-muted-foreground">
                {supLinhaQtd > 0 && `${supLinhaQtd} por estoque do próprio SKU`}
                {supLinhaQtd > 0 && supGrupoQtd > 0 && ' · '}
                {supGrupoQtd > 0 && `${supGrupoQtd} por estoque de um equivalente (mesmo galão)`}
              </p>
            )}
            <p className="mb-2 text-sm">
              <strong>O que fazer:</strong> clique em <em>Sincronizar e recalcular</em> (puxa o estoque do Omie e regenera). Os
              que tiverem saldo real entram no ciclo; os genuinamente zerados voltam a comprar sozinhos assim que o
              sync confirmar.
            </p>
            <ul className="list-disc pl-5 space-y-0.5 text-sm">
              {supUltimoRun.slice(0, 10).map((s) => (
                <li key={s.sku_codigo_omie}>
                  {s.sku_descricao ?? s.sku_codigo_omie}
                  <span className="text-muted-foreground font-mono text-xs"> · {s.sku_codigo_omie}</span>
                  {s.grupo_codigo && <span className="text-muted-foreground text-xs"> · grupo {s.grupo_codigo}</span>}
                </li>
              ))}
            </ul>
            {supUltimoRun.length > 10 && (
              <p className="mt-1 text-xs text-muted-foreground">+{supUltimoRun.length - 10} outro(s)</p>
            )}
            {supTotal24h > supUltimoRun.length && (
              <p className="mt-2 text-xs text-muted-foreground">
                {supTotal24h} no total nas últimas 24h (vários ciclos). Se isso se repete, o sync de estoque pode
                estar atrasando — vale checar a saúde do sync.
              </p>
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
                        {podeOverride && ehGateMinimoFaturamento(p) ? (
                          // Preso pelo gate de mínimo de faturamento → "Disparar mesmo assim"
                          // no lugar do "Re-disparar" (que só re-bateria no gate).
                          <OverrideMinimoButton
                            fornecedorNome={p.fornecedor_nome}
                            valorTotal={p.valor_total}
                            onConfirm={() => dispararOverrideMutation.mutate(p.id)}
                            disabled={disparandoLinha(p.id) || p.status_envio_portal === 'enviando_portal'}
                          />
                        ) : (p.status === 'aprovado_aguardando_disparo' || p.status === 'falha_envio') ? (
                          <Button
                            size="sm"
                            variant={p.status === 'falha_envio' ? 'outline' : 'default'}
                            onClick={() => dispararMutation.mutate(p.id)}
                            disabled={
                              disparandoLinha(p.id) ||
                              p.status_envio_portal === 'enviando_portal'
                            }
                          >
                            {disparandoLinha(p.id) ||
                            p.status_envio_portal === 'enviando_portal' ? (
                              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                            ) : (
                              <Zap className="w-4 h-4 mr-1" />
                            )}
                            {p.status === 'falha_envio' ? 'Re-disparar' : 'Disparar'}
                          </Button>
                        ) : null}
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
              <CardTitle className="text-base">Pedidos do dia ({ativos.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <PageSkeleton variant="list" />
              ) : ativos.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  {historico.length > 0
                    ? 'Nenhum pedido ativo hoje — veja o Histórico de hoje abaixo.'
                    : 'Nenhum pedido gerado para o ciclo de hoje. Use "Sincronizar e recalcular" para criar.'}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Fornecedor / Grupo</TableHead>
                      <TableHead className="text-right">Nº SKUs</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                      <TableHead>Portal</TableHead>
                      <TableHead>Aprovado em</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ativos.map((p) => (
                      <PedidoRow
                        key={p.id}
                        p={p}
                        onVerDetalhes={() => setDetalhesPedido(p)}
                        onCancelar={() => setCancelarPedido(p)}
                        onVerPortal={() => setPortalPedido(p)}
                        onDisparar={() => dispararMutation.mutate(p.id)}
                        onDispararIgnorandoMinimo={podeOverride ? () => dispararOverrideMutation.mutate(p.id) : undefined}
                        disparando={disparandoLinha(p.id)}
                      />
                    ))}
                  </TableBody>
                </Table>
              )}

              {!isLoading && historico.length > 0 && (
                <Collapsible open={histAberto} onOpenChange={setHistAberto} className="mt-4 border-t pt-2">
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="w-full flex items-center justify-between py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <span className="font-medium">Histórico de hoje ({historico.length})</span>
                      {histAberto ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <p className="text-xs text-muted-foreground pb-2">
                      Pedidos cancelados ou expirados de hoje. Ficam aqui só pra registro — não saem do banco.
                    </p>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Status</TableHead>
                          <TableHead>Fornecedor / Grupo</TableHead>
                          <TableHead className="text-right">Nº SKUs</TableHead>
                          <TableHead className="text-right">Valor</TableHead>
                          <TableHead>Portal</TableHead>
                          <TableHead>Aprovado em</TableHead>
                          <TableHead className="text-right">Ações</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {historico.map((p) => (
                          <PedidoRow
                            key={p.id}
                            p={p}
                            onVerDetalhes={() => setDetalhesPedido(p)}
                            onCancelar={() => setCancelarPedido(p)}
                            onVerPortal={() => setPortalPedido(p)}
                            onDisparar={() => dispararMutation.mutate(p.id)}
                            onDispararIgnorandoMinimo={podeOverride ? () => dispararOverrideMutation.mutate(p.id) : undefined}
                            disparando={disparandoLinha(p.id)}
                          />
                        ))}
                      </TableBody>
                    </Table>
                  </CollapsibleContent>
                </Collapsible>
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
