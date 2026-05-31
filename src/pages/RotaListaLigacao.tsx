import { useMemo } from 'react';
import { Phone } from 'lucide-react';
import { useRouteContactList } from '@/queries/useRouteContactList';
import type { RouteContactItem } from '@/queries/useRouteContactList';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { CallButton } from '@/components/call/CallButton';
import { RouteDisparoConfigPanel } from '@/components/rota/RouteDisparoConfigPanel';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const BUCKET_LABEL: Record<string, string> = {
  top: 'Prioridade',
  winback: 'Recuperar',
  coldstart: 'Novo cliente',
};

export default function RotaListaLigacao() {
  const workday = useMemo(() => todayIso(), []);
  const { data, isLoading } = useRouteContactList(workday);

  if (isLoading) return <PageSkeleton variant="list" />;

  const cidadesLabel = data?.cidades?.length ? data.cidades.join(', ') : null;

  if (!data || data.callQueue.length === 0) {
    return (
      <div className="p-4 space-y-3">
        <h1 className="font-display text-2xl">Lista de ligação por rota</h1>
        <RouteDisparoConfigPanel />
        <EmptyState
          icon={Phone}
          tone="operational"
          title={data?.dailyOnly ? 'Hoje só Divinópolis + Carmo do Cajuru' : 'Nenhum cliente na fila'}
          description={cidadesLabel ? `Cidades de amanhã: ${cidadesLabel}` : 'Sem rota para amanhã.'}
        />
      </div>
    );
  }

  // agrupa por vendedora (farmerName / farmerId)
  const byFarmer = new Map<string, RouteContactItem[]>();
  for (const c of data.callQueue) {
    const key = c.farmerName ?? c.farmerId ?? 'sem_dono';
    const list = byFarmer.get(key);
    if (list) list.push(c);
    else byFarmer.set(key, [c]);
  }

  return (
    <div className="p-4 space-y-4">
      <header>
        <h1 className="font-display text-2xl">Lista de ligação por rota</h1>
        <p className="text-sm text-muted-foreground">
          {data.dailyOnly
            ? 'Motor diário (Divinópolis + Carmo do Cajuru)'
            : `Rota de amanhã — ${cidadesLabel}`}
          {' · '}
          {data.callQueue.length} ligações priorizadas
        </p>
      </header>

      <RouteDisparoConfigPanel />

      {[...byFarmer.entries()].map(([farmer, list]) => (
        <Card key={farmer} className="p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Vendedora: {farmer === 'sem_dono' ? '—' : farmer}
          </div>
          <ol className="space-y-1">
            {list.map((c, i) => (
              <li key={c.customerUserId} className="flex items-center gap-2 py-1 border-b last:border-0">
                <span className="font-mono text-xs w-6 text-muted-foreground">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{c.name}</div>
                  <div className="text-xs text-muted-foreground font-tabular">{c.cityKey.city}</div>
                </div>
                {c.bucket && <Badge variant="secondary">{BUCKET_LABEL[c.bucket] ?? c.bucket}</Badge>}
                <span className="kpi-value text-sm w-24 text-right">R$ {Math.round(c.valorDaLigacao)}</span>
                {c.phone
                  ? <CallButton phone={c.phone} customerName={c.name} variant="icon" />
                  : <span className="text-xs text-muted-foreground w-8 text-center">—</span>}
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}
