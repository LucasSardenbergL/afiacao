import { DollarSign, Package, PiggyBank, TrendingUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatBRL } from "@/lib/reposicao";
import type { PedidoItem } from "@/types/reposicao";

type IconType = typeof Package;

function MetricCard({
  icon: I,
  label,
  value,
  extra,
}: {
  icon: IconType;
  label: string;
  value: string;
  extra?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
          <I className="h-3.5 w-3.5" />
          {label}
        </div>
        <div className="text-lg kpi-value">{value}</div>
        {extra}
      </CardContent>
    </Card>
  );
}

export function MetricsStrip({ items }: { items: PedidoItem[] }) {
  const totalSkus = items.reduce((s, r) => s + Number(r.num_skus ?? 0), 0);
  const valorEstimado = items.reduce((s, r) => s + Number(r.valor_total ?? 0), 0);
  const aprovados = items.filter((r) => !!r.aprovado_em).length;
  const pctAprovado = items.length > 0 ? (aprovados / items.length) * 100 : 0;
  const economia = 0;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <MetricCard icon={Package} label="SKUs sugeridos" value={totalSkus.toLocaleString("pt-BR")} />
      <MetricCard icon={DollarSign} label="Valor estimado" value={formatBRL(valorEstimado)} />
      <MetricCard
        icon={TrendingUp}
        label="% Aprovado"
        value={`${pctAprovado.toFixed(0)}%`}
        extra={<Progress value={pctAprovado} className="h-1.5 mt-2" />}
      />
      <MetricCard icon={PiggyBank} label="Economia potencial" value={formatBRL(economia)} />
    </div>
  );
}

