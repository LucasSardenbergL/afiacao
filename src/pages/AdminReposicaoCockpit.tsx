import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Sparkles, TrendingUp, Package, Zap, Loader2, PlayCircle, CalendarIcon, ExternalLink, ArrowUpRight, ArrowDownRight } from "lucide-react";
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

      <Card className="border-emerald-500/30 bg-gradient-to-br from-emerald-500/5 to-transparent">
        <CardHeader className="pb-2 flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Economia total potencial
            </CardTitle>
          </div>
          <Button
            size="sm"
            onClick={handleRodarGeracao}
            disabled={rodandoGeracao}
            className="shrink-0"
          >
            {rodandoGeracao ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
            ) : (
              <PlayCircle className="h-4 w-4 mr-1.5" />
            )}
            Rodar geração manual
          </Button>
        </CardHeader>
        <CardContent>
          <div className="text-3xl sm:text-4xl font-bold text-emerald-700 dark:text-emerald-400">
            {formatBRL(economiaTotal)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {filtradas.length} oportunidade{filtradas.length === 1 ? "" : "s"} ativa
            {filtradas.length === 1 ? "" : "s"} com janela de captura hoje
          </p>
        </CardContent>
      </Card>

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
