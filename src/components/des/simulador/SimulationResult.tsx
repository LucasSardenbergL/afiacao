// Resultado da simulação: posição/ganho/perdas + saldo líquido + cálculos detalhados.
// Extraído verbatim de src/components/des/SimuladorTab.tsx (god-component split).
import { useMemo } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Equal,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { SimResult } from "./types";
import { fmtBRL, fmtPct } from "./format";
import { StarsRow } from "./StarsRow";

interface SimulationResultProps {
  resultado: SimResult;
  showDetails: boolean;
  setShowDetails: (v: boolean) => void;
}

export function SimulationResult({ resultado, showDetails, setShowDetails }: SimulationResultProps) {
  const recomendacao = resultado?.recomendacao;
  const recomendCfg = useMemo(() => {
    switch (recomendacao) {
      case "compensa":
        return {
          icon: ThumbsUp,
          color: "text-status-success",
          bg: "bg-status-success/10 border-status-success/40",
          label: "Compensa",
        };
      case "compensa_marginalmente":
        return {
          icon: AlertCircle,
          color: "text-status-warning",
          bg: "bg-status-warning/10 border-status-warning/40",
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
          color: "text-status-error",
          bg: "bg-status-error/10 border-status-error/40",
          label: "Não compensa",
        };
      default:
        return null;
    }
  }, [recomendacao]);

  const fator = Number(resultado?.posicao?.fator_inflacao ?? 1);
  const perdas = resultado?.perdas_pedido_atual ?? {};

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Card 1 - Posição após puxar */}
        <Card className="bg-status-info/5 border-status-info/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">
              Posição após puxar
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xl font-bold text-status-info">
              {fmtBRL(resultado.posicao?.com_extra)}
            </p>
            <p className="text-xs text-muted-foreground">
              + {fmtBRL(resultado.posicao?.nominal_adicional_na_nf)}
            </p>
            {fator > 1 && (
              <Badge variant="outline" className="bg-status-warning/10 border-status-warning/40 text-status-warning text-xs">
                NF inflada em {fator.toFixed(2)}x pelo prazo
              </Badge>
            )}
            <div className="pt-1">
              {resultado.posicao?.mudou_faixa ? (
                <div className="flex items-center gap-1.5">
                  <Badge className="bg-status-success/10 border-status-success/40 text-status-success text-xs" variant="outline">
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
        <Card className="bg-status-success/5 border-status-success/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">
              Ganho futuro
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xl font-bold text-status-success">
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
        <Card className="bg-status-error/5 border-status-error/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">
              Perdas no pedido atual
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xl font-bold text-status-error">
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
  );
}
