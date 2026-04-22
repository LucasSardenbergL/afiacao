import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Equal,
  Info,
  Loader2,
  Play,
  Plus,
  Star,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface Props {
  empresa: string;
  ano: number;
  trimestre: number;
}

interface PrazoOption {
  id: number;
  codigo: string;
  nome: string;
  desconto_ou_encargo_perc: number;
  padrao: boolean;
  ativo: boolean;
}

interface SimResult {
  posicao?: {
    base?: number;
    com_extra?: number;
    nominal_adicional_na_nf?: number;
    fator_inflacao?: number;
    mudou_faixa?: boolean;
    faixa_atual?: { faixa_numero?: number; estrelas?: number };
    faixa_nova?: { faixa_numero?: number; estrelas?: number };
  };
  perdas_pedido_atual?: {
    perda_antecipado_rs?: number;
    encargo_prazo_rs?: number;
    frete_rs?: number;
    custo_capital_rs?: number;
    total_rs?: number;
  };
  projecao?: {
    proximo_trimestre_projetado?: number;
    ganho_futuro_rs?: number;
  };
  descontos?: {
    base_perc?: number;
    com_extra_perc?: number;
    delta_perc?: number;
  };
  saldo_liquido_rs?: number;
  recomendacao?: "compensa" | "compensa_marginalmente" | "indiferente" | "nao_compensa" | string;
  parametros?: Record<string, unknown>;
}

const fmtBRL = (v: number | null | undefined) =>
  v == null
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));

const fmtPct = (v: number | null | undefined) =>
  v == null ? "—" : `${Number(v).toFixed(2).replace(".", ",")}%`;

function StarsRow({ count, max = 6 }: { count: number; max?: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: max }).map((_, i) => (
        <Star
          key={i}
          className={cn(
            "h-3.5 w-3.5",
            i < count ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30",
          )}
        />
      ))}
    </div>
  );
}

interface SimulationPanelProps {
  empresa: string;
  ano: number;
  trimestre: number;
  prazos: PrazoOption[];
  defaultValor: number;
  defaultDias: number;
  defaultPrazo: string;
  faltamProximaFaixa: number | null;
  onClose?: () => void;
  title?: string;
}

function SimulationPanel({
  empresa,
  ano,
  trimestre,
  prazos,
  defaultValor,
  defaultDias,
  defaultPrazo,
  faltamProximaFaixa,
  onClose,
  title,
}: SimulationPanelProps) {
  const [valorExtra, setValorExtra] = useState<number>(defaultValor);
  const [valorInput, setValorInput] = useState<string>(String(defaultValor));
  const [diasEstoque, setDiasEstoque] = useState<number>(defaultDias);
  const [prazoCodigo, setPrazoCodigo] = useState<string>(defaultPrazo);
  const [resultado, setResultado] = useState<SimResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    setValorInput(String(valorExtra));
  }, [valorExtra]);

  async function simular() {
    if (valorExtra < 0) {
      toast.error("Valor extra deve ser ≥ 0");
      return;
    }
    if (diasEstoque < 1 || diasEstoque > 365) {
      toast.error("Dias de estoque extra deve estar entre 1 e 365");
      return;
    }
    const prazoValido = prazos.some((p) => p.codigo === prazoCodigo);
    if (!prazoValido) {
      toast.error("Prazo de pagamento inválido");
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.rpc(
        "simular_puxar_volume_trimestre" as any,
        {
          p_empresa: empresa,
          p_ano: ano,
          p_trimestre: trimestre,
          p_valor_extra: valorExtra,
          p_prazo_pagamento_codigo: prazoCodigo,
          p_dias_estoque_extra: diasEstoque,
        } as any,
      );
      if (error) throw error;
      setResultado(data as unknown as SimResult);
      toast.success("Cenário simulado");
    } catch (err: any) {
      console.error(err);
      toast.error("Erro ao simular: " + (err?.message ?? "desconhecido"));
    } finally {
      setLoading(false);
    }
  }

  const recomendacao = resultado?.recomendacao;
  const recomendCfg = useMemo(() => {
    switch (recomendacao) {
      case "compensa":
        return {
          icon: ThumbsUp,
          color: "text-green-700",
          bg: "bg-green-500/10 border-green-500/40",
          label: "Compensa",
        };
      case "compensa_marginalmente":
        return {
          icon: AlertCircle,
          color: "text-amber-700",
          bg: "bg-amber-500/10 border-amber-500/40",
          label: "Compensa marginalmente",
        };
      case "indiferente":
        return {
          icon: Equal,
          color: "text-muted-foreground",
          bg: "bg-muted/40 border-border",
          label: "Neutro",
        };
      case "nao_compensa":
        return {
          icon: ThumbsDown,
          color: "text-red-700",
          bg: "bg-red-500/10 border-red-500/40",
          label: "Não compensa",
        };
      default:
        return null;
    }
  }, [recomendacao]);

  const fator = Number(resultado?.posicao?.fator_inflacao ?? 1);
  const perdas = resultado?.perdas_pedido_atual ?? {};

  return (
    <Card className="relative">
      {title && (
        <div className="absolute top-3 right-3 flex items-center gap-2">
          {onClose && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
      {title && (
        <CardHeader className="pb-3">
          <CardTitle className="text-sm text-muted-foreground">{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent className={cn("space-y-6", !title && "pt-6")}>
        {/* LINHA 1 - Controles */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Coluna A - Valor extra */}
          <div className="space-y-3">
            <Label className="text-xs font-medium">Valor extra a puxar (R$)</Label>
            <Input
              type="number"
              value={valorInput}
              onChange={(e) => setValorInput(e.target.value)}
              onBlur={() => {
                const n = Number(valorInput);
                if (!isNaN(n) && n >= 0) setValorExtra(n);
                else setValorInput(String(valorExtra));
              }}
              min={0}
              step={1000}
              className="text-sm"
            />
            <Slider
              value={[valorExtra]}
              onValueChange={(v) => setValorExtra(v[0])}
              min={0}
              max={200000}
              step={5000}
            />
            <p className="text-xs text-muted-foreground">
              R$ 0 — R$ 200.000
            </p>
            {faltamProximaFaixa != null && faltamProximaFaixa > 0 && (
              <button
                type="button"
                className="inline-flex items-center text-xs px-2 py-1 rounded-md bg-amber-500/10 text-amber-700 border border-amber-500/30 hover:bg-amber-500/20 transition-colors"
                onClick={() => setValorExtra(Math.round(faltamProximaFaixa))}
              >
                Faltam para próxima faixa: {fmtBRL(faltamProximaFaixa)}
              </button>
            )}
          </div>

          {/* Coluna B - Prazo */}
          <div className="space-y-3">
            <Label className="text-xs font-medium">Prazo de pagamento</Label>
            <Select value={prazoCodigo} onValueChange={setPrazoCodigo}>
              <SelectTrigger className="text-sm">
                <SelectValue placeholder="Selecione" />
              </SelectTrigger>
              <SelectContent>
                {prazos.map((p) => {
                  const sinal = p.desconto_ou_encargo_perc >= 0 ? "+" : "";
                  return (
                    <SelectItem key={p.codigo} value={p.codigo}>
                      {p.nome} ({sinal}
                      {p.desconto_ou_encargo_perc.toFixed(2).replace(".", ",")}%)
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Antecipado dá desconto. Prazos longos cobram encargo.
            </p>
          </div>

          {/* Coluna C - Dias estoque */}
          <div className="space-y-3">
            <TooltipProvider>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs font-medium">Dias de estoque extra estimado</Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="text-xs">
                      Quantos dias o volume extra vai ficar parado além do seu giro normal. Afeta o custo de capital.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
            <Input
              type="number"
              value={diasEstoque}
              onChange={(e) => setDiasEstoque(Number(e.target.value))}
              min={1}
              max={365}
              step={1}
              className="text-sm"
            />
            <Slider
              value={[diasEstoque]}
              onValueChange={(v) => setDiasEstoque(v[0])}
              min={30}
              max={180}
              step={15}
            />
            <p className="text-xs text-muted-foreground">30 — 180 dias</p>
          </div>
        </div>

        {/* LINHA 2 - Botão */}
        <div className="flex justify-center">
          <Button size="lg" onClick={simular} disabled={loading} className="min-w-[200px]">
            {loading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Simular cenário
          </Button>
        </div>

        {/* LINHA 3 - Resultado */}
        {!resultado ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/30 p-8 text-center">
            <p className="text-sm text-muted-foreground">
              Ajuste os parâmetros e clique em Simular.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Card 1 - Posição após puxar */}
              <Card className="bg-blue-500/5 border-blue-500/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">
                    Posição após puxar
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-xl font-bold text-blue-700">
                    {fmtBRL(resultado.posicao?.com_extra)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    + {fmtBRL(resultado.posicao?.nominal_adicional_na_nf)}
                  </p>
                  {fator > 1 && (
                    <Badge variant="outline" className="bg-amber-500/10 border-amber-500/40 text-amber-700 text-xs">
                      NF inflada em {fator.toFixed(2)}x pelo prazo
                    </Badge>
                  )}
                  <div className="pt-1">
                    {resultado.posicao?.mudou_faixa ? (
                      <div className="flex items-center gap-1.5">
                        <Badge className="bg-green-500/10 border-green-500/40 text-green-700 text-xs" variant="outline">
                          Sobe para {resultado.posicao.faixa_nova?.estrelas ?? 0}★
                        </Badge>
                        <StarsRow count={resultado.posicao.faixa_nova?.estrelas ?? 0} />
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-xs">
                          Mantém {resultado.posicao?.faixa_atual?.estrelas ?? 0}★
                        </Badge>
                        <StarsRow count={resultado.posicao?.faixa_atual?.estrelas ?? 0} />
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Card 2 - Ganho futuro */}
              <Card className="bg-green-500/5 border-green-500/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">
                    Ganho futuro
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-xl font-bold text-green-700">
                    {fmtBRL(resultado.projecao?.ganho_futuro_rs)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    + {fmtPct(resultado.descontos?.delta_perc)} no próximo trimestre
                  </p>
                  <p className="text-xs text-muted-foreground">
                    sobre meta de {fmtBRL(resultado.projecao?.proximo_trimestre_projetado)}
                  </p>
                </CardContent>
              </Card>

              {/* Card 3 - Perdas */}
              <Card className="bg-red-500/5 border-red-500/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">
                    Perdas no pedido atual
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-xl font-bold text-red-700">
                    {fmtBRL(perdas.total_rs)}
                  </p>
                  <div className="space-y-0.5 text-xs">
                    <div className={cn("flex justify-between", !perdas.perda_antecipado_rs && "text-muted-foreground")}>
                      <span>Perda antecipado</span>
                      <span>{fmtBRL(perdas.perda_antecipado_rs)}</span>
                    </div>
                    <div className={cn("flex justify-between", !perdas.encargo_prazo_rs && "text-muted-foreground")}>
                      <span>Encargo do prazo</span>
                      <span>{fmtBRL(perdas.encargo_prazo_rs)}</span>
                    </div>
                    <div className={cn("flex justify-between", !perdas.frete_rs && "text-muted-foreground")}>
                      <span>Frete</span>
                      <span>{fmtBRL(perdas.frete_rs)}</span>
                    </div>
                    <div className={cn("flex justify-between", !perdas.custo_capital_rs && "text-muted-foreground")}>
                      <span>Custo de capital</span>
                      <span>{fmtBRL(perdas.custo_capital_rs)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* LINHA 4 - Saldo líquido */}
            {recomendCfg && (
              <Card className={cn("border-2", recomendCfg.bg)}>
                <CardContent className="pt-6 pb-6">
                  <div className="flex items-center justify-center gap-3">
                    <recomendCfg.icon className={cn("h-7 w-7", recomendCfg.color)} />
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
                        Saldo líquido
                      </p>
                      <p className={cn("text-3xl font-bold mt-1", recomendCfg.color)}>
                        {recomendCfg.label}: {fmtBRL(resultado.saldo_liquido_rs)}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* LINHA 5 - Detalhes */}
            <Collapsible open={showDetails} onOpenChange={setShowDetails}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs">
                  {showDetails ? <ChevronUp className="h-3 w-3 mr-1" /> : <ChevronDown className="h-3 w-3 mr-1" />}
                  Ver cálculos detalhados
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <Card className="mt-2">
                  <CardContent className="pt-4">
                    <Table>
                      <TableBody>
                        {Object.entries(resultado).map(([k, v]) => (
                          <TableRow key={k}>
                            <TableCell className="text-xs font-mono w-1/3 align-top text-muted-foreground">
                              {k}
                            </TableCell>
                            <TableCell className="text-xs font-mono">
                              <pre className="whitespace-pre-wrap break-all">
                                {typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)}
                              </pre>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function SimuladorTab({ empresa, ano, trimestre }: Props) {
  const [showCompare, setShowCompare] = useState(false);
  const [comparePrazo, setComparePrazo] = useState<string>("");

  // Prazos disponíveis
  const prazosQuery = useQuery({
    queryKey: ["des-prazos", empresa],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fornecedor_prazo_pagamento_config")
        .select("id, codigo, nome, desconto_ou_encargo_perc, padrao, ativo")
        .eq("empresa", empresa)
        .eq("ativo", true)
        .order("padrao", { ascending: false })
        .order("id");
      if (error) throw error;
      return (data ?? []) as PrazoOption[];
    },
  });

  // Posição atual (para faltam_proxima_faixa)
  const posQuery = useQuery({
    queryKey: ["des-posicao-sim", empresa, ano, trimestre],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_des_posicao_trimestre_ao_vivo" as any)
        .select("posicao_ao_vivo_conservadora, faixa_conservadora")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as {
        posicao_ao_vivo_conservadora: number | null;
        faixa_conservadora: { faixa_numero?: number; estrelas?: number; volume_max?: number } | null;
      } | null;
    },
  });

  // Faixas para descobrir o volume_min da próxima faixa
  const faixasQuery = useQuery({
    queryKey: ["des-faixas-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("des_faixa_quantitativa")
        .select("faixa_numero, estrelas, volume_min, volume_max")
        .order("faixa_numero", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Array<{
        faixa_numero: number;
        estrelas: number;
        volume_min: number;
        volume_max: number | null;
      }>;
    },
  });

  const faltamProximaFaixa = useMemo(() => {
    const conserv = Number(posQuery.data?.posicao_ao_vivo_conservadora ?? 0);
    const faixas = faixasQuery.data ?? [];
    const atualNumero = posQuery.data?.faixa_conservadora?.faixa_numero ?? 0;
    const proxima = faixas.find((f) => f.faixa_numero === atualNumero + 1);
    if (!proxima) return null;
    const gap = Number(proxima.volume_min) - conserv;
    return gap > 0 ? gap : null;
  }, [posQuery.data, faixasQuery.data]);

  const prazos = prazosQuery.data ?? [];
  const defaultPrazo = useMemo(
    () => prazos.find((p) => p.padrao)?.codigo ?? prazos[0]?.codigo ?? "antecipado",
    [prazos],
  );

  const compareDefault = useMemo(
    () => prazos.find((p) => p.codigo !== defaultPrazo)?.codigo ?? defaultPrazo,
    [prazos, defaultPrazo],
  );

  useEffect(() => {
    if (!comparePrazo && compareDefault) setComparePrazo(compareDefault);
  }, [compareDefault, comparePrazo]);

  if (prazosQuery.isLoading || posQuery.isLoading || faixasQuery.isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }

  return (
    <div className="space-y-6">
      {/* Card explicativo */}
      <Card className="bg-blue-500/5 border-blue-500/30">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-start gap-3">
            <Info className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
            <p className="text-xs text-foreground leading-relaxed">
              Simule o impacto financeiro de puxar volume extra no trimestre atual. Considera todos os custos
              (perda de antecipado, encargos, frete, custo de capital) e o ganho futuro de subir de faixa DES no
              próximo trimestre.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Painel principal */}
      <SimulationPanel
        empresa={empresa}
        ano={ano}
        trimestre={trimestre}
        prazos={prazos}
        defaultValor={50000}
        defaultDias={60}
        defaultPrazo={defaultPrazo}
        faltamProximaFaixa={faltamProximaFaixa}
      />

      {/* Comparador */}
      {!showCompare ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => setShowCompare(true)} disabled={prazos.length < 2}>
            <Plus className="h-4 w-4 mr-2" />
            Comparar com outro prazo de pagamento
          </Button>
        </div>
      ) : (
        <SimulationPanel
          empresa={empresa}
          ano={ano}
          trimestre={trimestre}
          prazos={prazos}
          defaultValor={50000}
          defaultDias={60}
          defaultPrazo={comparePrazo || compareDefault}
          faltamProximaFaixa={faltamProximaFaixa}
          onClose={() => setShowCompare(false)}
          title="Cenário comparativo"
        />
      )}
    </div>
  );
}
