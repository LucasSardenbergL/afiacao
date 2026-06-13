import { useRadarKpis } from '@/queries/useRadarKpis';
import { Skeleton } from '@/components/ui/skeleton';

function Card({ label, valor, hint }: { label: string; valor: number | string; hint?: string }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="kpi-value text-2xl">{valor}</div>
      {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

export function RadarKpis() {
  const { data, isLoading } = useRadarKpis();
  if (isLoading)
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  if (!data) return null;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Card
        label="Novos no lote"
        valor={data.novos.toLocaleString('pt-BR')}
        hint={data.lote ?? undefined}
      />
      <Card label="A contatar" valor={data.a_contatar.toLocaleString('pt-BR')} />
      <Card label="Em conversa" valor={data.em_conversa.toLocaleString('pt-BR')} />
      <Card label="Viraram cliente (mês)" valor={data.virou_cliente_mes.toLocaleString('pt-BR')} />
    </div>
  );
}
