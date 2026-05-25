// Modal de histórico de lead time do SKU selecionado (gráfico de linhas).
// Extraído verbatim de src/pages/AdminReposicaoSlaFornecedor.tsx (god-component split).
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { STATUS_LABEL, STATUS_VARIANT, fmtNum } from "./config";
import type { HistPoint, SkuCompliance } from "./types";

interface SkuHistoricoDialogProps {
  skuDetalhe: SkuCompliance | null;
  onOpenChange: (open: boolean) => void;
  historico: HistPoint[] | undefined;
  loadingHist: boolean;
}

export function SkuHistoricoDialog({ skuDetalhe, onOpenChange, historico, loadingHist }: SkuHistoricoDialogProps) {
  return (
    <Dialog open={!!skuDetalhe} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm">{skuDetalhe?.sku_codigo_omie}</span>
              <span className="text-sm font-normal text-muted-foreground truncate">
                {skuDetalhe?.sku_descricao}
              </span>
            </div>
          </DialogTitle>
        </DialogHeader>
        {skuDetalhe && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant={STATUS_VARIANT[skuDetalhe.status_sla]}>{STATUS_LABEL[skuDetalhe.status_sla]}</Badge>
              {skuDetalhe.fornecedor_nome && <Badge variant="outline">{skuDetalhe.fornecedor_nome}</Badge>}
              {skuDetalhe.grupo_codigo && <Badge variant="outline">Grupo {skuDetalhe.grupo_codigo}</Badge>}
              <Badge variant="outline">LT teórico: <span className="font-mono ml-1">{fmtNum(skuDetalhe.lt_teorico, 1)}d</span></Badge>
              <Badge variant="outline">Médio observado: <span className="font-mono ml-1">{fmtNum(skuDetalhe.lt_observado_medio, 1)}d</span></Badge>
            </div>
            <div className="h-[280px]">
              {loadingHist ? (
                <Skeleton className="h-full w-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={historico ?? []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="data" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} label={{ value: "dias úteis", angle: -90, position: "insideLeft", style: { fontSize: 11 } }} />
                    <ReTooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {skuDetalhe.lt_teorico != null && (
                      <ReferenceLine
                        y={skuDetalhe.lt_teorico}
                        stroke="hsl(var(--muted-foreground))"
                        strokeDasharray="4 4"
                        label={{ value: `Teórico ${skuDetalhe.lt_teorico}d`, position: "right", fontSize: 10 }}
                      />
                    )}
                    <Line
                      type="monotone"
                      dataKey="faturamento"
                      name="Faturamento"
                      stroke="hsl(217 91% 70%)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      dot={{ r: 2.5 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="logistica"
                      name="Logística"
                      stroke="hsl(25 95% 65%)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      dot={{ r: 2.5 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                    <Line type="monotone" dataKey="lt" name="LT bruto" stroke="hsl(var(--primary))" strokeWidth={2.5} isAnimationActive={false} dot={(props: { cx?: number; cy?: number; payload?: { lt: number | null } }) => {
                      const { cx, cy, payload } = props;
                      const violou = skuDetalhe.lt_teorico != null && payload?.lt != null && payload.lt > skuDetalhe.lt_teorico * 1.25;
                      return (
                        <circle cx={cx} cy={cy} r={4} fill={violou ? "hsl(var(--destructive))" : "hsl(var(--primary))"} stroke="white" strokeWidth={1} />
                      );
                    }} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Pontos vermelhos indicam recebimentos que ultrapassaram 25% do LT teórico. As linhas pontilhadas
              decompõem o LT em faturamento (fornecedor) e logística (transportadora) para diagnóstico.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
