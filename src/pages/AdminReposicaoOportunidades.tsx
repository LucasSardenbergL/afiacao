import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Sparkles,
  Loader2,
  RefreshCw,
  PlayCircle,
  ChevronRight,
  MoreVertical,
  EyeOff,
  ArrowRight,
  Handshake,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";

import { Cenario, Oportunidade, OrdemKey } from "@/components/reposicao/oportunidades/types";
import {
  EMPRESA,
  ALL,
  CENARIOS,
  formatBRL,
  formatNumber,
  formatDate,
  formatDateLong,
  diasEntre,
  cenarioIcon,
  cenarioLabel,
  descontoBadgeClass,
  diasBadge,
} from "@/components/reposicao/oportunidades/shared";
import { EstadoVazio, DrawerConteudo } from "@/components/reposicao/oportunidades/components";

export default function AdminReposicaoOportunidades() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [cenariosSelecionados, setCenariosSelecionados] = useState<Set<Cenario>>(
    new Set(CENARIOS.map((c) => c.value)),
  );
  const [filtroFornecedor, setFiltroFornecedor] = useState<string>(ALL);
  const [ordenacao, setOrdenacao] = useState<OrdemKey>("economia");
  const [apenasComEconomia, setApenasComEconomia] = useState(true);
  const [ignoradosLocal, setIgnoradosLocal] = useState<Set<number>>(new Set());
  const [drawerSku, setDrawerSku] = useState<Oportunidade | null>(null);
  const [confirmCicloOpen, setConfirmCicloOpen] = useState(false);
  const [executandoCiclo, setExecutandoCiclo] = useState(false);
  const [bannerNegociacaoFechado, setBannerNegociacaoFechado] = useState(
    () => typeof window !== 'undefined' && sessionStorage.getItem('banner-negociacao-fechado') === '1',
  );

  // Contador de sugestões "novas" de negociação paralela (banner)
  const { data: negociacaoNovasCount = 0 } = useQuery({
    queryKey: ["negociacao-paralela-sugestoes-count"],
    queryFn: async () => {
      const { count } = await supabase
        .from("v_sugestao_negociacao_ativa" as never)
        .select("*", { count: "exact", head: true })
        .eq("empresa", EMPRESA)
        .eq("status", "nova");
      return count ?? 0;
    },
    staleTime: 30_000,
  });

  // ============ QUERIES ============
  const { data: oportunidades = [], isLoading, isFetching } = useQuery({
    queryKey: ["oportunidades-hoje", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_oportunidade_economica_hoje" as never)
        .select("*")
        .eq("empresa", EMPRESA);
      if (error) throw error;
      return ((data || []) as unknown) as Oportunidade[];
    },
  });

  const { data: totalSkusAtivos = 0 } = useQuery({
    queryKey: ["sku-parametros-count", EMPRESA],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("sku_parametros")
        .select("*", { count: "exact", head: true })
        .eq("empresa", EMPRESA)
        .eq("ativo", true);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const { data: cicloHoje = 0 } = useQuery({
    queryKey: ["ciclo-hoje", EMPRESA],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

      const [promo, aumento] = await Promise.all([
        supabase
          .from("promocao_campanha")
          .select("id", { count: "exact", head: true })
          .eq("empresa", EMPRESA)
          .eq("estado", "ativa")
          .eq("data_corte_pedido", today),
        supabase
          .from("fornecedor_aumento_anunciado")
          .select("id", { count: "exact", head: true })
          .eq("empresa", EMPRESA)
          .in("estado", ["ativo", "vigente"])
          .eq("data_vigencia", tomorrow),
      ]);

      return (promo.count ?? 0) + (aumento.count ?? 0);
    },
  });

  // Quick reference: histórico total de campanhas de promoção
  const { data: historicoPromocoes } = useQuery({
    queryKey: ["historico-promocoes-count", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("promocao_campanha")
        .select("data_inicio")
        .eq("empresa", EMPRESA);
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<{ data_inicio: string | null }>;
      const meses = new Set<string>();
      for (const r of rows) {
        const k = r.data_inicio?.slice(0, 7);
        if (k) meses.add(k);
      }
      return { campanhas: rows.length, meses: meses.size };
    },
  });

  // ============ DERIVED STATE ============
  const fornecedoresUnicos = useMemo(() => {
    const set = new Set<string>();
    oportunidades.forEach((o) => {
      if (o.fornecedor_nome) set.add(o.fornecedor_nome);
    });
    return Array.from(set).sort();
  }, [oportunidades]);

  const oportunidadesFiltradas = useMemo(() => {
    let arr = oportunidades.filter((o) => !ignoradosLocal.has(o.sku_codigo_omie));
    arr = arr.filter((o) => cenariosSelecionados.has(o.cenario));
    if (filtroFornecedor !== ALL) {
      arr = arr.filter((o) => o.fornecedor_nome === filtroFornecedor);
    }
    if (apenasComEconomia) {
      arr = arr.filter((o) => Number(o.economia_bruta_estimada ?? 0) > 0);
    }
    arr.sort((a, b) => {
      switch (ordenacao) {
        case "economia":
          return Number(b.economia_bruta_estimada ?? 0) - Number(a.economia_bruta_estimada ?? 0);
        case "data_limite":
          return (a.dias_ate_limite ?? 9999) - (b.dias_ate_limite ?? 9999);
        case "desconto":
          return Number(b.desconto_total_perc ?? 0) - Number(a.desconto_total_perc ?? 0);
        case "sku":
          return (a.sku_descricao ?? "").localeCompare(b.sku_descricao ?? "");
      }
    });
    return arr;
  }, [oportunidades, ignoradosLocal, cenariosSelecionados, filtroFornecedor, apenasComEconomia, ordenacao]);

  // ============ KPIs ============
  const totalEconomia = useMemo(
    () =>
      oportunidades.reduce(
        (acc, o) => acc + Number(o.economia_bruta_estimada ?? 0),
        0,
      ),
    [oportunidades],
  );

  const dataLimiteMaisProxima = useMemo(() => {
    const datas = oportunidades
      .map((o) => o.data_limite_acao)
      .filter((d): d is string => !!d)
      .sort();
    return datas[0] ?? null;
  }, [oportunidades]);

  const diasAteLimite = useMemo(
    () => diasEntre(dataLimiteMaisProxima),
    [dataLimiteMaisProxima],
  );

  // ============ HANDLERS ============
  const toggleCenario = (c: Cenario, checked: boolean) => {
    setCenariosSelecionados((prev) => {
      const next = new Set(prev);
      if (checked) next.add(c);
      else next.delete(c);
      return next;
    });
  };

  const handleAtualizar = () => {
    queryClient.invalidateQueries({ queryKey: ["oportunidades-hoje"] });
    queryClient.invalidateQueries({ queryKey: ["sku-parametros-count"] });
    queryClient.invalidateQueries({ queryKey: ["ciclo-hoje"] });
    toast.success("Posição atualizada");
  };

  const handleIgnorar = (sku: number) => {
    setIgnoradosLocal((prev) => new Set(prev).add(sku));
    toast.info("SKU oculto até o próximo refresh");
  };

  const handleGerarCiclo = async () => {
    setExecutandoCiclo(true);
    try {
      const { data, error } = await supabase.rpc("ciclo_oportunidade_do_dia" as never, {
        p_empresa: EMPRESA,
      } as never);
      if (error) throw error;

      const result = (data ?? {}) as {
        pedidos_criados?: number;
        skus_incluidos?: number;
        valor_total?: number;
      };
      toast.success(
        `Ciclo gerado: ${result.pedidos_criados ?? 0} pedidos · ${
          result.skus_incluidos ?? 0
        } SKUs · ${formatBRL(result.valor_total ?? 0)}`,
      );
      setConfirmCicloOpen(false);
      queryClient.invalidateQueries({ queryKey: ["oportunidades-hoje"] });
      queryClient.invalidateQueries({ queryKey: ["ciclo-hoje"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao gerar ciclo de oportunidade");
    } finally {
      setExecutandoCiclo(false);
    }
  };

  const cenariosLabel =
    cenariosSelecionados.size === CENARIOS.length
      ? "Todos os cenários"
      : `${cenariosSelecionados.size} cenário${cenariosSelecionados.size === 1 ? "" : "s"}`;

  return (
    <TooltipProvider>
      <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <Sparkles className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Oportunidades</h1>
              <p className="text-sm text-muted-foreground">
                Promoções e aumentos com janela de captura ativa hoje
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {cicloHoje > 0 && (
              <Button size="sm" onClick={() => setConfirmCicloOpen(true)}>
                <PlayCircle className="h-4 w-4" /> Gerar ciclo oportunidade
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={handleAtualizar}>
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
              Atualizar posição
            </Button>
          </div>
        </header>

        {!bannerNegociacaoFechado && negociacaoNovasCount > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-status-info/30 bg-status-info/10 px-4 py-3 text-sm">
            <div className="flex items-center gap-2 flex-1">
              <Handshake className="h-4 w-4 text-status-info dark:text-status-info shrink-0" />
              <span>
                <strong>{negociacaoNovasCount}</strong> SKU{negociacaoNovasCount === 1 ? '' : 's'}{' '}
                {negociacaoNovasCount === 1 ? 'foi sugerido' : 'foram sugeridos'} para negociação paralela.
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate('/admin/reposicao/negociacao-paralela')}
              >
                Ver sugestões
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => {
                  sessionStorage.setItem('banner-negociacao-fechado', '1');
                  setBannerNegociacaoFechado(true);
                }}
                aria-label="Fechar"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {historicoPromocoes && historicoPromocoes.campanhas > 0 && (
          <div className="text-xs text-muted-foreground -mt-2">
            Histórico de promoções:{" "}
            <button
              type="button"
              onClick={() => navigate("/admin/reposicao/promocoes")}
              className="font-medium text-foreground hover:underline"
            >
              {historicoPromocoes.campanhas}{" "}
              {historicoPromocoes.campanhas === 1 ? "campanha" : "campanhas"}
            </button>{" "}
            em {historicoPromocoes.meses}{" "}
            {historicoPromocoes.meses === 1 ? "mês" : "meses"}
          </div>
        )}

        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                Economia total potencial hoje
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-status-success tabular-nums">
                {formatBRL(totalEconomia)}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                considerando promoções e aumentos vigentes
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                SKUs com oportunidade
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tabular-nums">
                {oportunidades.length}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                de {totalSkusAtivos} SKUs ativos
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                Data limite mais próxima
              </CardTitle>
            </CardHeader>
            <CardContent>
              {dataLimiteMaisProxima ? (
                <>
                  <div className="text-lg font-bold tabular-nums">
                    {formatDateLong(dataLimiteMaisProxima)}
                  </div>
                  <div className="mt-1">
                    <Badge variant="outline" className={diasBadge(diasAteLimite)}>
                      em {diasAteLimite} {diasAteLimite === 1 ? "dia" : "dias"}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Próxima janela crítica
                  </p>
                </>
              ) : (
                <>
                  <div className="text-lg font-bold text-muted-foreground">—</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Sem janelas ativas
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                Ciclo oportunidade do dia
              </CardTitle>
            </CardHeader>
            <CardContent>
              {cicloHoje > 0 ? (
                <>
                  <Badge
                    className="bg-status-success/15 text-status-success border-status-success/30 cursor-pointer hover:bg-status-success/25"
                    variant="outline"
                    onClick={() => setConfirmCicloOpen(true)}
                  >
                    <PlayCircle className="h-3 w-3 mr-1" />
                    Gerar ciclo oportunidade
                  </Badge>
                  <p className="text-xs text-muted-foreground mt-2">
                    {cicloHoje} {cicloHoje === 1 ? "evento" : "eventos"} encerra(m) hoje
                  </p>
                </>
              ) : (
                <>
                  <Badge variant="outline" className="text-muted-foreground">
                    Sem ciclo hoje
                  </Badge>
                  <p className="text-xs text-muted-foreground mt-2">
                    Próxima janela crítica ainda não chegou
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Filtros + Tabela */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Oportunidades ativas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="justify-between">
                    {cenariosLabel}
                    <ChevronRight className="h-4 w-4 rotate-90 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56" align="start">
                  {CENARIOS.map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c.value}
                      checked={cenariosSelecionados.has(c.value)}
                      onCheckedChange={(checked) => toggleCenario(c.value, !!checked)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      <span className="flex items-center gap-2">
                        {cenarioIcon(c.value)}
                        {c.label}
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <Select value={filtroFornecedor} onValueChange={setFiltroFornecedor}>
                <SelectTrigger>
                  <SelectValue placeholder="Fornecedor" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todos os fornecedores</SelectItem>
                  {fornecedoresUnicos.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={ordenacao} onValueChange={(v) => setOrdenacao(v as OrdemKey)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="economia">Maior economia</SelectItem>
                  <SelectItem value="data_limite">Data limite mais próxima</SelectItem>
                  <SelectItem value="desconto">Maior % desconto</SelectItem>
                  <SelectItem value="sku">SKU alfabético</SelectItem>
                </SelectContent>
              </Select>

              <div className="flex items-center justify-end gap-2 px-2">
                <Switch
                  id="apenas-economia"
                  checked={apenasComEconomia}
                  onCheckedChange={setApenasComEconomia}
                />
                <Label htmlFor="apenas-economia" className="text-sm cursor-pointer">
                  Apenas com economia &gt; 0
                </Label>
              </div>
            </div>

            {/* Tabela */}
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
                <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
              </div>
            ) : oportunidades.length === 0 ? (
              <EstadoVazio navigate={navigate} />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"></TableHead>
                      <TableHead>SKU / Descrição</TableHead>
                      <TableHead>Fornecedor</TableHead>
                      <TableHead className="text-right">Desconto total</TableHead>
                      <TableHead className="text-right">Qtde sugerida</TableHead>
                      <TableHead>Data limite</TableHead>
                      <TableHead className="text-right">Economia bruta</TableHead>
                      <TableHead className="w-20 text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {oportunidadesFiltradas.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-muted-foreground py-12">
                          Nenhum SKU bate os filtros atuais.
                        </TableCell>
                      </TableRow>
                    )}
                    {oportunidadesFiltradas.map((o) => (
                      <TableRow key={`${o.sku_codigo_omie}-${o.cenario}`}>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex">{cenarioIcon(o.cenario)}</span>
                            </TooltipTrigger>
                            <TooltipContent>{cenarioLabel(o.cenario)}</TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium tabular-nums text-xs text-muted-foreground">
                            {o.sku_codigo_omie}
                          </div>
                          <div className="text-sm">{o.sku_descricao ?? "—"}</div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {o.fornecedor_nome ?? "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge
                                variant="outline"
                                className={descontoBadgeClass(o.desconto_total_perc)}
                              >
                                {formatNumber(o.desconto_total_perc, 1)}%
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <div className="space-y-1 text-xs">
                                <div>
                                  Base promo: {formatNumber(o.desconto_promo_perc, 2)}%
                                </div>
                                {o.tem_negociacao_extra && (
                                  <div>+ Extra negociado</div>
                                )}
                                {o.aumento_evitado_perc !== null &&
                                  Number(o.aumento_evitado_perc) > 0 && (
                                    <div>
                                      + Aumento evitado:{" "}
                                      {formatNumber(o.aumento_evitado_perc, 2)}%
                                    </div>
                                  )}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="font-medium">
                                {formatNumber(o.qtde_oportunidade, 0)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="text-xs space-y-1">
                                <div>
                                  Demanda diária: {formatNumber(o.demanda_diaria, 2)}
                                </div>
                                <div>
                                  Quantidade base EOQ: {formatNumber(o.qtde_base, 0)}
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell className="text-sm">
                          <div className="tabular-nums">{formatDate(o.data_limite_acao)}</div>
                          <div className="text-xs text-muted-foreground">
                            {o.dias_ate_limite !== null
                              ? `em ${o.dias_ate_limite} ${o.dias_ate_limite === 1 ? "dia" : "dias"}`
                              : ""}
                          </div>
                        </TableCell>
                        <TableCell
                          className={`text-right tabular-nums font-medium ${
                            Number(o.economia_bruta_estimada ?? 0) > 0
                              ? "text-status-success"
                              : "text-muted-foreground"
                          }`}
                        >
                          {formatBRL(o.economia_bruta_estimada)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              onClick={() => setDrawerSku(o)}
                            >
                              <ChevronRight className="h-4 w-4" />
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon" variant="ghost" className="h-8 w-8">
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={() =>
                                    navigate(
                                      `/admin/reposicao/skus/${o.sku_codigo_omie}`,
                                    )
                                  }
                                >
                                  <ArrowRight className="h-4 w-4 mr-2" />
                                  Ir para SKU em reposição
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => handleIgnorar(o.sku_codigo_omie)}
                                >
                                  <EyeOff className="h-4 w-4 mr-2" />
                                  Ignorar hoje
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Drawer de detalhes */}
        <Sheet open={!!drawerSku} onOpenChange={(o) => !o && setDrawerSku(null)}>
          <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
            {drawerSku && <DrawerConteudo o={drawerSku} navigate={navigate} />}
          </SheetContent>
        </Sheet>

        {/* Confirmação ciclo */}
        <AlertDialog open={confirmCicloOpen} onOpenChange={setConfirmCicloOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Gerar ciclo de oportunidade do dia</AlertDialogTitle>
              <AlertDialogDescription>
                Vai gerar pedidos de oportunidade para{" "}
                <strong>{oportunidades.length} SKUs</strong>, com economia total
                estimada de{" "}
                <strong className="text-status-success">
                  {formatBRL(totalEconomia)}
                </strong>
                . Continuar?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={executandoCiclo}>
                Cancelar
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  handleGerarCiclo();
                }}
                disabled={executandoCiclo}
              >
                {executandoCiclo && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Confirmar e gerar
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}
