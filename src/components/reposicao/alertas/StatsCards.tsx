// Grid de estatísticas (6 KPIs) dos Alertas de Outlier.
// Extraído de src/pages/AdminReposicaoAlertas.tsx (god-component split).
import { Card, CardContent } from "@/components/ui/card";
import type { OutlierStats } from "./types";

export function StatsCards({ stats }: { stats?: OutlierStats }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
      <Card>
        <CardContent className="pt-4">
          <div className="text-xs text-muted-foreground">Total pendentes</div>
          <div className="text-2xl font-bold">{stats?.pendentes ?? 0}</div>
        </CardContent>
      </Card>
      <Card className="border-destructive/40">
        <CardContent className="pt-4">
          <div className="text-xs text-destructive">Críticos</div>
          <div className="text-2xl font-bold text-destructive">{stats?.criticos ?? 0}</div>
        </CardContent>
      </Card>
      <Card className="border-warning/40">
        <CardContent className="pt-4">
          <div className="text-xs text-warning">Atenção</div>
          <div className="text-2xl font-bold text-warning">{stats?.atencao ?? 0}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-xs text-muted-foreground">Informativos</div>
          <div className="text-2xl font-bold">{stats?.info ?? 0}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-xs text-success">Aceitos hoje</div>
          <div className="text-2xl font-bold">{stats?.aceitosHoje ?? 0}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <div className="text-xs text-destructive">Excluídos hoje</div>
          <div className="text-2xl font-bold">{stats?.excluidosHoje ?? 0}</div>
        </CardContent>
      </Card>
    </div>
  );
}
