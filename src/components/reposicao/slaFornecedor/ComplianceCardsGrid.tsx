// Grid de cards de compliance global por fornecedor.
// Extraído verbatim de src/pages/AdminReposicaoSlaFornecedor.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cardTone, fmtNum } from "./config";
import type { ForCompliance } from "./types";

interface ComplianceCardsGridProps {
  fornecedores: ForCompliance[] | undefined;
  loading: boolean;
}

export function ComplianceCardsGrid({ fornecedores, loading: loadingFor }: ComplianceCardsGridProps) {
  return (
    <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
      {loadingFor &&
        Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
      {!loadingFor &&
        fornecedores?.map((f) => (
          <Card key={f.fornecedor_nome} className={cardTone(f.perc_sla_compliance)}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between gap-2">
                <span className="truncate" title={f.fornecedor_nome}>{f.fornecedor_nome}</span>
                <Badge variant="outline" className="shrink-0">{f.skus_total} SKUs</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="text-3xl font-bold">
                {f.perc_sla_compliance != null ? `${f.perc_sla_compliance}%` : "—"}
                <span className="text-xs font-normal text-muted-foreground ml-1">compliance</span>
              </div>
              <div className="text-xs text-muted-foreground">
                LT teórico: <span className="font-mono">{fmtNum(f.lt_teorico_agregado)}d</span> · observado:{" "}
                <span className="font-mono">{fmtNum(f.lt_medio_observado_agregado)}d</span>
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Badge variant="success">{f.skus_cumprindo} ok</Badge>
                <Badge variant="warning">{f.skus_limite} limite</Badge>
                <Badge variant="warning">{f.skus_violando} viol.</Badge>
                <Badge variant="destructive">{f.skus_criticos} crít.</Badge>
              </div>
            </CardContent>
          </Card>
        ))}
      {!loadingFor && (fornecedores?.length ?? 0) === 0 && (
        <Card className="md:col-span-3">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Nenhum fornecedor com dados de SLA disponíveis ainda.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
