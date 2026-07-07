// Gráfico de faturamento por trimestre (BarChart + linha de meta média).
// Extraído verbatim de src/components/des/HistoricoTab.tsx (god-component split).
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtBRL } from "./format";
import type { ChartDatum } from "./types";

interface FaturamentoChartProps {
  chartData: ChartDatum[];
  metaMedia: number;
}

export function FaturamentoChart({ chartData, metaMedia }: FaturamentoChartProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Faturamento por trimestre</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--muted-foreground))"
                tickFormatter={(v) => `R$ ${(v / 1000).toFixed(0)}k`}
              />
              <RTooltip
                formatter={(v: number) => fmtBRL(v)}
                contentStyle={{
                  backgroundColor: "hsl(var(--background))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <Bar dataKey="faturado" name="Faturado" radius={[4, 4, 0, 0]}>
                {chartData.map((d, i) => (
                  <Cell
                    key={i}
                    fill={
                      d.isAtual
                        ? "hsl(var(--status-info))"
                        : d.faturado >= d.meta
                          ? "hsl(var(--status-success))"
                          : "hsl(var(--status-error))"
                    }
                  />
                ))}
              </Bar>
              {metaMedia > 0 && (
                <ReferenceLine
                  y={metaMedia}
                  stroke="hsl(var(--foreground))"
                  strokeDasharray="4 4"
                  label={{
                    value: `Meta média: ${fmtBRL(metaMedia)}`,
                    position: "right",
                    fontSize: 10,
                    fill: "hsl(var(--muted-foreground))",
                  }}
                />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
