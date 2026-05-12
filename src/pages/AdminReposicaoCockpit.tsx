import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Sparkles, TrendingUp, Package, Zap, Loader2, PlayCircle, CalendarIcon, ExternalLink, ArrowUpRight, ArrowDownRight, AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
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

const EMPRESA = "OBEN";
const ALL = "__all__";

type Cenario = "promo_flat" | "promo_volume" | "promo_e_aumento" | "aumento_apenas";

const CENARIOS: Array<{ value: Cenario; label: string }> = [
  { value: "promo_flat", label: "Promoção flat" },
  { value: "promo_volume", label: "Promoção volume" },
  { value: "promo_e_aumento", label: "Promo + aumento" },
  { value: "aumento_apenas", label: "Aumento apenas" },
];

type Oportunidade = {
  empresa: string;
  sku_codigo_omie: number;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  cenario: Cenario;
  desconto_total_perc: number | null;
  data_limite_acao: string | null;
  dias_ate_limite: number | null;
  economia_bruta_estimada: number | null;
};

const formatBRL = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));

const formatPerc = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${Number(v).toFixed(2)}%`;

const formatDate = (d: string | null | undefined) => {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
};

const cenarioLabel = (c: Cenario) => CENARIOS.find((x) => x.value === c)?.label ?? c;

const cenarioIcon = (c: Cenario) => {
  switch (c) {
    case "promo_flat":
      return <Sparkles className="h-3.5 w-3.5 text-amber-500" />;
    case "promo_volume":
      return <Package className="h-3.5 w-3.5 text-blue-500" />;
    case "promo_e_aumento":
      return <Zap className="h-3.5 w-3.5 text-purple-500" />;
    case "aumento_apenas":
      return <TrendingUp className="h-3.5 w-3.5 text-red-500" />;
  }
};

const diasBadgeClass = (d: number | null | undefined) => {
  const v = d ?? 999;
  if (v < 3) return "bg-destructive/15 text-destructive border-destructive/30";
  if (v < 7) return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
  return "bg-muted text-muted-foreground border-border";
};

const STATUS_PEDIDO_LABEL: Record<string, { label: string; className: string }> = {
  pendente_aprovacao: { label: "Pend. aprovação", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30" },
  aprovado_aguardando_disparo: { label: "Aprovado", className: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30" },
  disparado: { label: "Disparado", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" },
  disparado_simulado: { label: "Simulado", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" },
  cancelado: { label: "Cancelado", className: "bg-destructive/15 text-destructive border-destructive/30" },
  expirado_sem_aprovacao: { label: "Expirado", className: "bg-muted text-muted-foreground border-border" },
  falha_envio: { label: "Falha envio", className: "bg-destructive/15 text-destructive border-destructive/30" },
};

const STATUS_PORTAL_LABEL: Record<string, { label: string; className: string }> = {
  enviado: { label: "Enviado", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" },
  pendente: { label: "Aguardando envio", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30" },
  aguardando: { label: "Aguardando envio", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30" },
  falha: { label: "Falha", className: "bg-destructive/15 text-destructive border-destructive/30" },
  erro: { label: "Falha", className: "bg-destructive/15 text-destructive border-destructive/30" },
};

const formatDateTime = (d: string | null | undefined) => {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

export default function AdminReposicaoCockpit() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [filtroCenario, setFiltroCenario] = useState<string>(ALL);
  const [filtroFornecedor, setFiltroFornecedor] = useState<string>(ALL);
  const [rodandoGeracao, setRodandoGeracao] = useState(false);
  const [dataFim, setDataFim] = useState<Date>(() => new Date());

  type PedidoDia = {
    id: number;
    status: string | null;
    fornecedor_nome: string | null;
    grupo_codigo: string | null;
    num_skus: number | null;
    valor_total: number | null;
    delta_vs_anterior_perc: number | null;
    horario_corte_planejado: string | null;
    status_envio_portal: string | null;
    aprovado_em: string | null;
    aprovado_por: string | null;
    portal_protocolo: string | null;
  };

  const { data: pedidosHoje = [], isLoading: loadingPedidos } = useQuery({
    queryKey: ["cockpit-pedidos-hoje", EMPRESA],
    queryFn: async () => {
      const hoje = format(new Date(), "yyyy-MM-dd");
      const { data, error } = await supabase
        .from("pedido_compra_sugerido" as any)
        .select(
          "id,status,fornecedor_nome,grupo_codigo,num_skus,valor_total,delta_vs_anterior_perc,horario_corte_planejado,status_envio_portal,aprovado_em,aprovado_por,portal_protocolo",
        )
        .eq("empresa", EMPRESA)
        .eq("data_ciclo", hoje)
        .order("valor_total", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as unknown) as PedidoDia[];
    },
  });

  type FilaParam = {
    id: string;
    sku_codigo_omie: number;
    sku_descricao: string | null;
    estoque_minimo: number | null;
    ponto_pedido: number | null;
    estoque_maximo: number | null;
    estoque_minimo_omie: number | null;
    ponto_pedido_omie: number | null;
    estoque_maximo_omie: number | null;
    omie_ultima_sincronizacao: string | null;
    aprovado_em: string | null;
  };

  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [aplicando, setAplicando] = useState(false);
  const [sincronizandoOmie, setSincronizandoOmie] = useState(false);

  const { data: filaParametros = [], isLoading: loadingFila } = useQuery({
    queryKey: ["cockpit-fila-parametros", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sku_parametros" as any)
        .select(
          "id,sku_codigo_omie,sku_descricao,estoque_minimo,ponto_pedido,estoque_maximo,estoque_minimo_omie,ponto_pedido_omie,estoque_maximo_omie,omie_ultima_sincronizacao,aprovado_em",
        )
        .eq("empresa", EMPRESA)
        .eq("ativo", true)
        .not("aprovado_em", "is", null)
        .order("sku_codigo_omie", { ascending: true })
        .limit(500);
      if (error) throw error;
      const rows = ((data ?? []) as unknown) as FilaParam[];
      // Apenas com diferença em pelo menos 1 dos 3 parâmetros
      return rows.filter((r) => {
        const dEM = Math.abs(Number(r.estoque_minimo ?? 0) - Number(r.estoque_minimo_omie ?? 0));
        const dPP = Math.abs(Number(r.ponto_pedido ?? 0) - Number(r.ponto_pedido_omie ?? 0));
        const dMx = Math.abs(Number(r.estoque_maximo ?? 0) - Number(r.estoque_maximo_omie ?? 0));
        return dEM + dPP + dMx > 0;
      });
    },
  });

  const ultimaSincFila = useMemo(() => {
    let max = 0;
    for (const r of filaParametros) {
      const t = r.omie_ultima_sincronizacao ? new Date(r.omie_ultima_sincronizacao).getTime() : 0;
      if (t > max) max = t;
    }
    return max ? new Date(max) : null;
  }, [filaParametros]);

  const sincDesatualizada = useMemo(() => {
    if (!ultimaSincFila) return true;
    return Date.now() - ultimaSincFila.getTime() > 24 * 60 * 60 * 1000;
  }, [ultimaSincFila]);

  const toggleSelecionado = (id: string) => {
    setSelecionados((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const toggleSelecionarTodos = () => {
    setSelecionados((prev) =>
      prev.size === filaParametros.length ? new Set() : new Set(filaParametros.map((r) => r.id)),
    );
  };

  const handleAplicarSelecionados = async () => {
    if (selecionados.size === 0) return;
    setAplicando(true);
    try {
      const ids = Array.from(selecionados);
      const { error } = await supabase
        .from("sku_parametros" as any)
        .update({
          aplicar_no_omie: true,
          aprovado_em: new Date().toISOString(),
        })
        .in("id", ids);
      if (error) throw error;
      toast.success(`${ids.length} SKU(s) marcado(s) para aplicação no Omie`);
      setSelecionados(new Set());
      queryClient.invalidateQueries({ queryKey: ["cockpit-fila-parametros"] });
    } catch (e: any) {
      toast.error(e?.message || "Erro ao marcar para aplicação");
    } finally {
      setAplicando(false);
    }
  };

  const handleSincronizarOmie = async () => {
    setSincronizandoOmie(true);
    try {
      const { data, error } = await supabase.functions.invoke("omie-sync-status-produtos", {
        body: { empresa: EMPRESA },
      });
      if (error) throw error;
      toast.success("Sincronização com Omie iniciada com sucesso");
      queryClient.invalidateQueries({ queryKey: ["cockpit-fila-parametros"] });
    } catch (e: any) {
      toast.error(e?.message || "Erro ao sincronizar com Omie");
    } finally {
      setSincronizandoOmie(false);
    }
  };

  const dataInicio = useMemo(() => {
    const d = new Date(dataFim);
    d.setDate(d.getDate() - 29);
    return d;
  }, [dataFim]);

  const { data: historicoDiario = [], isLoading: loadingHistorico } = useQuery({
    queryKey: ["cockpit-historico-30d", EMPRESA, format(dataFim, "yyyy-MM-dd")],
    queryFn: async () => {
      const inicio = format(dataInicio, "yyyy-MM-dd");
      const fim = format(dataFim, "yyyy-MM-dd");
      const { data, error } = await supabase
        .from("pedido_compra_sugerido" as any)
        .select("data_ciclo,fornecedor_nome,valor_total,status")
        .eq("empresa", EMPRESA)
        .gte("data_ciclo", inicio)
        .lte("data_ciclo", fim);
      if (error) throw error;
      type Row = { data_ciclo: string; fornecedor_nome: string | null; valor_total: number | null; status: string | null };
      const rows = ((data ?? []) as unknown) as Row[];
      const map = new Map<string, { data: string; fornecedores: Set<string>; pedidos: number; valor: number; disparados: number; cancelados: number }>();
      for (const r of rows) {
        const key = r.data_ciclo;
        if (!map.has(key)) {
          map.set(key, { data: key, fornecedores: new Set(), pedidos: 0, valor: 0, disparados: 0, cancelados: 0 });
        }
        const acc = map.get(key)!;
        if (r.fornecedor_nome) acc.fornecedores.add(r.fornecedor_nome);
        acc.pedidos += 1;
        acc.valor += Number(r.valor_total ?? 0);
        if (r.status === "disparado" || r.status === "disparado_simulado") acc.disparados += 1;
        if (r.status === "cancelado") acc.cancelados += 1;
      }
      return Array.from(map.values())
        .map((x) => ({ ...x, fornecedores: x.fornecedores.size }))
        .sort((a, b) => b.data.localeCompare(a.data));
    },
  });

  const handleRodarGeracao = async () => {
    setRodandoGeracao(true);
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
      queryClient.invalidateQueries({ queryKey: ["cockpit-oportunidades"] });
      refetch();
    } catch (e: any) {
      toast.error(e?.message || "Erro ao gerar ciclo de oportunidade");
    } finally {
      setRodandoGeracao(false);
    }
  };

  const { data: oportunidades = [], isLoading, refetch } = useQuery({
    queryKey: ["cockpit-oportunidades", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_oportunidade_economica_hoje" as any)
        .select(
          "empresa,sku_codigo_omie,sku_descricao,fornecedor_nome,cenario,desconto_total_perc,data_limite_acao,dias_ate_limite,economia_bruta_estimada",
        )
        .eq("empresa", EMPRESA);
      if (error) throw error;
      return ((data || []) as unknown) as Oportunidade[];
    },
  });

  const fornecedoresUnicos = useMemo(() => {
    const set = new Set<string>();
    oportunidades.forEach((o) => o.fornecedor_nome && set.add(o.fornecedor_nome));
    return Array.from(set).sort();
  }, [oportunidades]);

  const filtradas = useMemo(() => {
    return oportunidades
      .filter((o) => filtroCenario === ALL || o.cenario === filtroCenario)
      .filter((o) => filtroFornecedor === ALL || o.fornecedor_nome === filtroFornecedor)
      .sort(
        (a, b) =>
          Number(b.economia_bruta_estimada ?? 0) - Number(a.economia_bruta_estimada ?? 0),
      );
  }, [oportunidades, filtroCenario, filtroFornecedor]);

  const economiaTotal = useMemo(
    () => filtradas.reduce((acc, o) => acc + Number(o.economia_bruta_estimada ?? 0), 0),
    [filtradas],
  );

  const fornecedoresHoje = useMemo(() => {
    const set = new Set<string>();
    pedidosHoje.forEach((p) => p.fornecedor_nome && set.add(p.fornecedor_nome));
    return set.size;
  }, [pedidosHoje]);

  const skusHoje = useMemo(
    () => pedidosHoje.reduce((acc, p) => acc + Number(p.num_skus ?? 0), 0),
    [pedidosHoje],
  );

  const valorHoje = useMemo(
    () => pedidosHoje.reduce((acc, p) => acc + Number(p.valor_total ?? 0), 0),
    [pedidosHoje],
  );

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
      <header className="flex items-center gap-3">
        <Sparkles className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Cockpit de Reposição</h1>
          <p className="text-sm text-muted-foreground">
            Visão consolidada das oportunidades ativas e potencial de economia
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-emerald-500/30 bg-gradient-to-br from-emerald-500/5 to-transparent">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Economia total potencial
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl sm:text-3xl font-bold text-emerald-700 dark:text-emerald-400">
              {formatBRL(economiaTotal)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {filtradas.length} oportunidade{filtradas.length === 1 ? "" : "s"} ativa
              {filtradas.length === 1 ? "" : "s"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Fornecedores c/ pedido hoje
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl sm:text-3xl font-bold">{fornecedoresHoje}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {pedidosHoje.length} pedido{pedidosHoje.length === 1 ? "" : "s"} gerado
              {pedidosHoje.length === 1 ? "" : "s"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Total de SKUs hoje
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl sm:text-3xl font-bold">{skusHoje}</div>
            <p className="text-xs text-muted-foreground mt-1">Itens nos pedidos do dia</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Valor total hoje
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl sm:text-3xl font-bold">{formatBRL(valorHoje)}</div>
            <p className="text-xs text-muted-foreground mt-1">Soma dos pedidos gerados</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={handleRodarGeracao}
          disabled={rodandoGeracao}
        >
          {rodandoGeracao ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
          ) : (
            <PlayCircle className="h-4 w-4 mr-1.5" />
          )}
          Rodar geração manual
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Cenário</label>
          <Select value={filtroCenario} onValueChange={setFiltroCenario}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos os cenários</SelectItem>
              {CENARIOS.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1">
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            Fornecedor
          </label>
          <Select value={filtroFornecedor} onValueChange={setFiltroFornecedor}>
            <SelectTrigger>
              <SelectValue />
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
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Oportunidades ativas</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Carregando...
            </div>
          ) : filtradas.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Nenhuma oportunidade encontrada com os filtros atuais.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Fornecedor</TableHead>
                  <TableHead>Cenário</TableHead>
                  <TableHead className="text-right">Desconto total %</TableHead>
                  <TableHead className="text-right">Economia estimada</TableHead>
                  <TableHead>Data limite</TableHead>
                  <TableHead className="text-right">Dias restantes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtradas.map((o) => (
                  <TableRow key={`${o.empresa}-${o.sku_codigo_omie}-${o.cenario}`}>
                    <TableCell className="font-mono text-xs">{o.sku_codigo_omie}</TableCell>
                    <TableCell className="max-w-xs truncate">{o.sku_descricao ?? "—"}</TableCell>
                    <TableCell className="text-sm">{o.fornecedor_nome ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="gap-1 font-normal">
                        {cenarioIcon(o.cenario)}
                        {cenarioLabel(o.cenario)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatPerc(o.desconto_total_perc)}
                    </TableCell>
                    <TableCell className="text-right font-medium text-emerald-700 dark:text-emerald-400">
                      {formatBRL(o.economia_bruta_estimada)}
                    </TableCell>
                    <TableCell className="text-sm">{formatDate(o.data_limite_acao)}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant="outline" className={diasBadgeClass(o.dias_ate_limite)}>
                        {o.dias_ate_limite ?? "—"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="text-base">Fila de aplicação de parâmetros</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              SKUs aprovados com EM/PP/Emax divergentes do Omie
            </p>
          </div>
          <Button
            size="sm"
            onClick={handleAplicarSelecionados}
            disabled={aplicando || selecionados.size === 0}
          >
            {aplicando ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
            ) : (
              <CheckCircle2 className="h-4 w-4 mr-1.5" />
            )}
            Aplicar selecionados ({selecionados.size})
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {sincDesatualizada && filaParametros.length > 0 && (
            <div className="px-6 pb-3">
              <Alert className="bg-amber-500/10 border-amber-500/30 text-amber-900 dark:text-amber-200">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Sincronização desatualizada</AlertTitle>
                <AlertDescription className="flex items-center gap-2 flex-wrap">
                  {ultimaSincFila
                    ? `Última sincronização com Omie em ${formatDateTime(ultimaSincFila.toISOString())}. Os valores "atual" podem estar defasados.`
                    : "Nenhuma sincronização recente com Omie detectada para os SKUs da fila."}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-amber-600/40 hover:bg-amber-500/20"
                    onClick={handleSincronizarOmie}
                    disabled={sincronizandoOmie}
                  >
                    {sincronizandoOmie ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <RefreshCw className="h-3 w-3 mr-1" />
                    )}
                    Sincronizar agora
                  </Button>
                </AlertDescription>
              </Alert>
            </div>
          )}
          {loadingFila ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Carregando...
            </div>
          ) : filaParametros.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Nenhum SKU pendente de aplicação no Omie.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={
                        selecionados.size > 0 && selecionados.size === filaParametros.length
                      }
                      onCheckedChange={toggleSelecionarTodos}
                      aria-label="Selecionar todos"
                    />
                  </TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead className="text-right">EM (atual → novo)</TableHead>
                  <TableHead className="text-right">PP (atual → novo)</TableHead>
                  <TableHead className="text-right">Emax (atual → novo)</TableHead>
                  <TableHead className="text-right">Δ máx</TableHead>
                  <TableHead className="text-right">Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filaParametros.map((r) => {
                  const emA = Number(r.estoque_minimo_omie ?? 0);
                  const emN = Number(r.estoque_minimo ?? 0);
                  const ppA = Number(r.ponto_pedido_omie ?? 0);
                  const ppN = Number(r.ponto_pedido ?? 0);
                  const mxA = Number(r.estoque_maximo_omie ?? 0);
                  const mxN = Number(r.estoque_maximo ?? 0);
                  const dEM = emN - emA;
                  const dPP = ppN - ppA;
                  const dMx = mxN - mxA;
                  const deltaMax = Math.max(Math.abs(dEM), Math.abs(dPP), Math.abs(dMx));
                  const renderDelta = (atual: number, novo: number) => {
                    const diff = novo - atual;
                    const cls =
                      diff > 0
                        ? "text-emerald-700 dark:text-emerald-400"
                        : diff < 0
                          ? "text-destructive"
                          : "text-muted-foreground";
                    return (
                      <span className="text-sm">
                        <span className="text-muted-foreground">{atual}</span>
                        <span className="mx-1">→</span>
                        <span className={cn("font-medium", cls)}>{novo}</span>
                      </span>
                    );
                  };
                  const isSel = selecionados.has(r.id);
                  return (
                    <TableRow key={r.id} data-state={isSel ? "selected" : undefined}>
                      <TableCell>
                        <Checkbox
                          checked={isSel}
                          onCheckedChange={() => toggleSelecionado(r.id)}
                          aria-label={`Selecionar SKU ${r.sku_codigo_omie}`}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.sku_codigo_omie}</TableCell>
                      <TableCell className="text-sm max-w-xs truncate">
                        {r.sku_descricao ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">{renderDelta(emA, emN)}</TableCell>
                      <TableCell className="text-right">{renderDelta(ppA, ppN)}</TableCell>
                      <TableCell className="text-right">{renderDelta(mxA, mxN)}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="outline" className="font-mono">
                          {deltaMax.toFixed(0)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            setSelecionados(new Set([r.id]));
                            await handleAplicarSelecionados();
                          }}
                          disabled={aplicando}
                        >
                          Aplicar
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pedidos do dia</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Pedidos sugeridos com data de ciclo em {format(new Date(), "dd/MM/yyyy")}
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {loadingPedidos ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Carregando...
            </div>
          ) : pedidosHoje.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Nenhum pedido gerado para hoje.
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
                  <TableHead>Corte</TableHead>
                  <TableHead>Status portal</TableHead>
                  <TableHead>Aprovado</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pedidosHoje.map((p) => {
                  const statusInfo = STATUS_PEDIDO_LABEL[p.status ?? ""] ?? {
                    label: p.status ?? "—",
                    className: "bg-muted text-muted-foreground border-border",
                  };
                  const portalInfo = STATUS_PORTAL_LABEL[p.status_envio_portal ?? ""];
                  const delta = Number(p.delta_vs_anterior_perc ?? 0);
                  const deltaPositive = delta > 0;
                  const deltaNegative = delta < 0;
                  return (
                    <TableRow key={p.id}>
                      <TableCell>
                        <Badge variant="outline" className={statusInfo.className}>
                          {statusInfo.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        <div className="font-medium">{p.fornecedor_nome ?? "—"}</div>
                        {p.grupo_codigo && (
                          <div className="text-xs text-muted-foreground">{p.grupo_codigo}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{p.num_skus ?? 0}</TableCell>
                      <TableCell className="text-right font-medium">
                        {formatBRL(p.valor_total)}
                      </TableCell>
                      <TableCell className="text-right">
                        {p.delta_vs_anterior_perc === null || p.delta_vs_anterior_perc === undefined ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span
                            className={cn(
                              "inline-flex items-center gap-0.5 text-sm font-medium",
                              deltaPositive && "text-emerald-700 dark:text-emerald-400",
                              deltaNegative && "text-destructive",
                            )}
                          >
                            {deltaPositive && <ArrowUpRight className="h-3 w-3" />}
                            {deltaNegative && <ArrowDownRight className="h-3 w-3" />}
                            {delta.toFixed(1)}%
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {formatDateTime(p.horario_corte_planejado)}
                      </TableCell>
                      <TableCell>
                        {portalInfo ? (
                          <Badge variant="outline" className={portalInfo.className}>
                            {portalInfo.label}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {p.aprovado_em ? (
                          <div>
                            <div>{formatDateTime(p.aprovado_em)}</div>
                            {p.aprovado_por && (
                              <div className="text-xs text-muted-foreground">{p.aprovado_por}</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => navigate(`/admin/reposicao/pedidos?id=${p.id}`)}
                          >
                            Detalhes
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => navigate(`/admin/portal-sayerlack?pedido=${p.id}`)}
                          >
                            <ExternalLink className="h-3.5 w-3.5 mr-1" />
                            Abrir portal
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="text-base">Histórico — últimos 30 dias</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              {format(dataInicio, "dd/MM/yyyy")} até {format(dataFim, "dd/MM/yyyy")}
            </p>
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn("justify-start text-left font-normal", !dataFim && "text-muted-foreground")}
              >
                <CalendarIcon className="h-4 w-4 mr-2" />
                {format(dataFim, "dd/MM/yyyy")}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="single"
                selected={dataFim}
                onSelect={(d) => d && setDataFim(d)}
                disabled={(d) => d > new Date()}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
            </PopoverContent>
          </Popover>
        </CardHeader>
        <CardContent className="p-0">
          {loadingHistorico ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Carregando...
            </div>
          ) : historicoDiario.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Nenhum pedido no período selecionado.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead className="text-right">Fornecedores</TableHead>
                  <TableHead className="text-right">Pedidos</TableHead>
                  <TableHead className="text-right">Valor total</TableHead>
                  <TableHead className="text-right">Disparados</TableHead>
                  <TableHead className="text-right">Cancelados</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {historicoDiario.map((d) => (
                  <TableRow key={d.data}>
                    <TableCell className="text-sm">{formatDate(d.data)}</TableCell>
                    <TableCell className="text-right">{d.fornecedores}</TableCell>
                    <TableCell className="text-right">{d.pedidos}</TableCell>
                    <TableCell className="text-right font-medium">{formatBRL(d.valor)}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant="outline" className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30">
                        {d.disparados}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {d.cancelados > 0 ? (
                        <Badge variant="outline" className="bg-destructive/15 text-destructive border-destructive/30">
                          {d.cancelados}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
