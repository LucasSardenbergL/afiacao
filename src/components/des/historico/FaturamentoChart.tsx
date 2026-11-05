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
  /** `null` = nenhuma meta positiva no recorte → sem linha de referência. */
  metaMedia: number | null;
}

// Cor da barra pelo julgamento (./derivar): trimestre sem meta/faturado é neutro, nunca verde
// por `faturado >= 0` nem vermelho por faturado fabricado. Faturado `null` = sem barra.
const COR_POR_JULGAMENTO: Record<ChartDatum["julgamento"], string> = {
  em_andamento: "hsl(var(--status-info))",
  atingida: "hsl(var(--status-success))",
  nao_atingida: "hsl(var(--status-error))",
  sem_fechamento: "hsl(var(--muted-foreground))",
  sem_dado: "hsl(var(--muted-foreground))",
  planejado: "hsl(var(--muted-foreground))",
};

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
                // O nome da série vem da proveniência do ponto: a barra do trimestre atual é
                // POSIÇÃO (faturado + pedidos), e a de um snapshot parcial é "Faturado até dd/mm".
                formatter={(v: number, _nome, item) => [
                  fmtBRL(v),
                  (item?.payload as ChartDatum | undefined)?.rotulo ?? "Faturado",
                ]}
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
                    fill={COR_POR_JULGAMENTO[d.julgamento]}
                  />
                ))}
              </Bar>
              {metaMedia !== null && (
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
