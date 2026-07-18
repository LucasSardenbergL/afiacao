// Cards do Motor de Custo (fallback inteligente) e Regras de Associação (Apriori).
// Extraídos verbatim de src/pages/AdminAnalyticsSync.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw, Calculator, GitBranch } from "lucide-react";
import { UltimaExecucao } from "@/components/execucoes/UltimaExecucao";
import { type RecConfigs } from "./useAnalyticsSync";
import { ACOES_ANALYTICS_SYNC } from "./acoes";

export function CostEngineCard({
  isRunning,
  pending,
  recConfigs,
  onRecalcular,
}: {
  isRunning: boolean;
  pending: boolean;
  recConfigs: RecConfigs;
  onRecalcular: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calculator className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Motor de Custo (Fallback Inteligente)</CardTitle>
          </div>
          <Button variant="outline" size="sm" disabled={isRunning} onClick={onRecalcular}>
            <RefreshCw className={`h-3 w-3 mr-2 ${pending ? "animate-spin" : ""}`} />
            Recalcular Custos
          </Button>
        </div>
        <UltimaExecucao acao={ACOES_ANALYTICS_SYNC.recalcularCustos} />
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          Hierarquia: Custo Produto → CMC (Estoque) → CMC Margem Atípica → Proxy Família → Proxy Default.
          Divergência {">"} {((recConfigs?.find(c => c.key === "divergence_threshold")?.value || 0.2) * 100).toFixed(0)}%
          aplica heurística estoque vs encomenda.
        </p>
        <div className="grid grid-cols-5 gap-3 text-center text-xs">
          {["PRODUCT_COST", "CMC", "CMC_MARGEM_ATIPICA", "FAMILY_MARGIN_PROXY", "DEFAULT_PROXY"].map((source) => (
            <div key={source} className="p-2 rounded bg-muted">
              <div className="font-medium">{source.replace(/_/g, " ")}</div>
              <div className="text-muted-foreground mt-1">
                Confiança: {source === "PRODUCT_COST" ? "95%" : source === "CMC" ? "80%" : source === "CMC_MARGEM_ATIPICA" ? "60%" : source === "FAMILY_MARGIN_PROXY" ? "50%" : "25%"}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function AssociationRulesCard({
  isRunning,
  pending,
  recConfigs,
  onRecalcular,
}: {
  isRunning: boolean;
  pending: boolean;
  recConfigs: RecConfigs;
  onRecalcular: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Regras de Associação (Apriori)</CardTitle>
          </div>
          <Button variant="outline" size="sm" disabled={isRunning} onClick={onRecalcular}>
            <RefreshCw className={`h-3 w-3 mr-2 ${pending ? "animate-spin" : ""}`} />
            Recalcular Regras
          </Button>
        </div>
        <UltimaExecucao acao={ACOES_ANALYTICS_SYNC.recalcularRegras} />
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          Analisa co-ocorrências em pedidos para gerar regras do tipo "quem comprou A também comprou B".
          Filtros: lift ≥ {recConfigs?.find(c => c.key === "l_min")?.value ?? 1.2}, support ≥ {recConfigs?.find(c => c.key === "s_min")?.value ?? 0.01}.
          As regras alimentam o score Assoc(j|B) do motor de recomendação.
        </p>
      </CardContent>
    </Card>
  );
}
