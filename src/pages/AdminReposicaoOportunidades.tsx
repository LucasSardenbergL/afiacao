import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Sparkles,
  Package,
  Zap,
  TrendingUp,
  Loader2,
  RefreshCw,
  PlayCircle,
  ChevronRight,
  MoreVertical,
  ExternalLink,
  EyeOff,
  ArrowRight,
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
  SheetHeader,
  SheetTitle,
  SheetDescription,
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

const EMPRESA = "OBEN";
const ALL = "__all__";

type Cenario = "promo_flat" | "promo_volume" | "promo_e_aumento" | "aumento_apenas";

const CENARIOS: Array<{ value: Cenario; label: string }> = [
  { value: "promo_flat", label: "Promoção flat" },
  { value: "promo_volume", label: "Promoção volume" },
  { value: "promo_e_aumento", label: "Promo + aumento" },
  { value: "aumento_apenas", label: "Aumento apenas" },
];

type AumentoRef = {
  aumento_id: number;
  aumento_nome?: string;
  data_vigencia?: string;
  categoria?: string;
  aumento_perc?: number;
};

type Oportunidade = {
  empresa: string;
  sku_codigo_omie: number;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  cenario: Cenario;
  desconto_total_perc: number | null;
  desconto_promo_perc: number | null;
  aumento_evitado_perc: number | null;
  tem_negociacao_extra: boolean | null;
  campanha_id: number | null;
  campanha_nome: string | null;
  promo_item_id: number | null;
  modo_promo: string | null;
  promo_data_corte_pedido: string | null;
  promo_data_corte_faturamento: string | null;
  proxima_vigencia_aumento: string | null;
  aumentos_json: AumentoRef[] | null;
  data_limite_acao: string | null;
  dias_ate_limite: number | null;
  demanda_diaria: number | null;
  qtde_base: number | null;
  qtde_oportunidade: number | null;
  preco_item_eoq: number | null;
  economia_bruta_estimada: number | null;
  custo_capital_efetivo_perc: number | null;
};

type OrdemKey = "economia" | "data_limite" | "desconto" | "sku";

function formatBRL(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(v));
}

function formatNumber(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—";
  return Number(v).toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDate(d: string | null | undefined): string {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}

function formatDateLong(d: string | null | undefined): string {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  const meses = [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
  ];
  return `${parseInt(day, 10)} de ${meses[parseInt(m, 10) - 1]}`;
}

function diasEntre(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const target = new Date(y, m - 1, d).getTime();
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((target - now.getTime()) / (1000 * 60 * 60 * 24));
}

function cenarioIcon(cenario: Cenario) {
  switch (cenario) {
    case "promo_flat":
      return <Sparkles className="h-4 w-4 text-amber-500" />;
    case "promo_volume":
      return <Package className="h-4 w-4 text-blue-500" />;
    case "promo_e_aumento":
      return <Zap className="h-4 w-4 text-purple-500" />;
    case "aumento_apenas":
      return <TrendingUp className="h-4 w-4 text-red-500" />;
  }
}

function cenarioLabel(cenario: Cenario): string {
  return CENARIOS.find((c) => c.value === cenario)?.label ?? cenario;
}

function descontoBadgeClass(p: number | null | undefined): string {
  const v = Number(p ?? 0);
  if (v >= 15) return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
  if (v >= 7) return "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30";
  if (v > 0) return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
  return "bg-muted text-muted-foreground border-border";
}

function diasBadge(dias: number | null | undefined) {
  const d = dias ?? 999;
  if (d < 3) return "bg-destructive/15 text-destructive border-destructive/30";
  if (d < 7) return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
  return "bg-muted text-muted-foreground border-border";
}

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
        .from("v_sugestao_negociacao_ativa" as any)
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
        .from("v_oportunidade_economica_hoje" as any)
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
        .from("sku_parametros" as any)
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
          .from("promocao_campanha" as any)
          .select("id", { count: "exact", head: true })
          .eq("empresa", EMPRESA)
          .eq("estado", "ativa")
          .eq("data_corte_pedido", today),
        supabase
          .from("fornecedor_aumento_anunciado" as any)
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
      const { data, error } = await (supabase as any)
        .from("promocao_campanha")
        .select("data_inicio")
        .eq("empresa", EMPRESA);
      if (error) throw error;
      const rows = (data ?? []) as Array<{ data_inicio: string | null }>;
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
      const { data, error } = await supabase.rpc("ciclo_oportunidade_do_dia" as any, {
        p_empresa: EMPRESA,
      });
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
    } catch (e: any) {
      toast.error(e?.message || "Erro ao gerar ciclo de oportunidade");
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
          <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm">
            <div className="flex items-center gap-2 flex-1">
              <Handshake className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
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
              <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
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
                    className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 cursor-pointer hover:bg-emerald-500/25"
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
                              ? "text-emerald-600 dark:text-emerald-400"
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
                <strong className="text-emerald-600 dark:text-emerald-400">
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

// ============ SUBCOMPONENTES ============

function EstadoVazio({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <TrendingUp className="h-16 w-16 text-muted-foreground/40 mb-4" />
      <h3 className="text-xl font-semibold">Nenhuma oportunidade ativa</h3>
      <p className="text-sm text-muted-foreground mt-2 max-w-md">
        Não há promoções ou aumentos ativos que afetem seus SKUs no momento.
        Cadastre promoções ou aumentos para começar.
      </p>
      <div className="flex gap-2 mt-6">
        <Button
          variant="outline"
          onClick={() => navigate("/admin/reposicao/promocoes")}
        >
          Ver promoções
        </Button>
        <Button
          variant="outline"
          onClick={() => navigate("/admin/reposicao/aumentos")}
        >
          Ver aumentos
        </Button>
      </div>
    </div>
  );
}

function DrawerConteudo({
  o,
  navigate,
}: {
  o: Oportunidade;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const incluiPromo = o.cenario.startsWith("promo");
  const incluiAumento =
    o.cenario === "aumento_apenas" || o.cenario === "promo_e_aumento";
  const aumentos = (o.aumentos_json ?? []) as AumentoRef[];

  return (
    <>
      <SheetHeader>
        <div className="flex items-center gap-2">
          {cenarioIcon(o.cenario)}
          <Badge variant="outline">{cenarioLabel(o.cenario)}</Badge>
        </div>
        <SheetTitle className="text-left">
          {o.sku_descricao ?? "Sem descrição"}
        </SheetTitle>
        <SheetDescription className="text-left tabular-nums">
          SKU {o.sku_codigo_omie} · {o.fornecedor_nome ?? "—"}
        </SheetDescription>
      </SheetHeader>

      <div className="mt-6 space-y-5">
        {/* Parâmetros */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Parâmetros operacionais</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Linha label="Demanda diária" value={formatNumber(o.demanda_diaria, 2)} />
            <Linha label="Preço EOQ" value={formatBRL(o.preco_item_eoq)} />
            <Linha
              label="Custo de capital"
              value={`${formatNumber(o.custo_capital_efetivo_perc, 2)}%`}
            />
            <Linha label="Quantidade base (EOQ)" value={formatNumber(o.qtde_base, 0)} />
            <Linha
              label="Quantidade sugerida"
              value={formatNumber(o.qtde_oportunidade, 0)}
              highlight
            />
          </CardContent>
        </Card>

        {/* Promoção */}
        {incluiPromo && o.campanha_id && (
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-500" />
                Promoção ativa
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="font-medium">{o.campanha_nome}</div>
              <Linha
                label="Modo"
                value={o.modo_promo === "volume" ? "Volume" : "Flat"}
              />
              <Linha
                label="Desconto base"
                value={`${formatNumber(o.desconto_promo_perc, 2)}%`}
              />
              {o.tem_negociacao_extra && (
                <Linha label="Negociação extra" value="Sim" />
              )}
              <Linha
                label="Corte do pedido"
                value={formatDate(o.promo_data_corte_pedido)}
              />
              <Linha
                label="Corte do faturamento"
                value={formatDate(o.promo_data_corte_faturamento)}
              />
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-2"
                onClick={() => navigate(`/admin/reposicao/promocoes/${o.campanha_id}`)}
              >
                <ExternalLink className="h-3 w-3 mr-2" />
                Ver campanha
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Aumentos */}
        {incluiAumento && aumentos.length > 0 && (
          <Card className="border-red-500/30 bg-red-500/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-red-500" />
                {aumentos.length === 1
                  ? "Aumento afetando este SKU"
                  : `${aumentos.length} aumentos afetando este SKU`}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {aumentos.map((a, i) => (
                <div
                  key={`${a.aumento_id}-${i}`}
                  className="space-y-1.5 pb-3 border-b last:border-0 last:pb-0 text-sm"
                >
                  <div className="font-medium">{a.aumento_nome ?? "Aumento"}</div>
                  {a.categoria && (
                    <div className="text-xs text-muted-foreground">
                      Categoria: {a.categoria}
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Vigência</span>
                    <span className="tabular-nums">{formatDate(a.data_vigencia)}</span>
                  </div>
                  {typeof a.aumento_perc === "number" && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">% aumento</span>
                      <span className="font-medium tabular-nums text-red-600 dark:text-red-400">
                        +{formatNumber(a.aumento_perc, 2)}%
                      </span>
                    </div>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full mt-1"
                    onClick={() => navigate(`/admin/reposicao/aumentos/${a.aumento_id}`)}
                  >
                    <ExternalLink className="h-3 w-3 mr-2" />
                    Ver aumento
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Cálculo */}
        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Cálculo da economia</CardTitle>
          </CardHeader>
          <CardContent className="text-sm leading-relaxed">
            Comprando{" "}
            <strong>{formatNumber(o.qtde_oportunidade, 0)} unidades</strong> nos
            próximos{" "}
            <strong>
              {o.dias_ate_limite ?? "—"}{" "}
              {o.dias_ate_limite === 1 ? "dia" : "dias"}
            </strong>{" "}
            você captura{" "}
            <strong>{formatNumber(o.desconto_total_perc, 2)}%</strong> de
            benefício total, economizando{" "}
            <strong className="text-emerald-700 dark:text-emerald-400">
              {formatBRL(o.economia_bruta_estimada)}
            </strong>{" "}
            bruto.
          </CardContent>
        </Card>

        <Button
          className="w-full"
          onClick={() => navigate(`/admin/reposicao/skus/${o.sku_codigo_omie}`)}
        >
          <ArrowRight className="h-4 w-4 mr-2" />
          Ir para SKU em reposição
        </Button>
      </div>
    </>
  );
}

function Linha({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${highlight ? "font-semibold" : ""}`}>
        {value}
      </span>
    </div>
  );
}
