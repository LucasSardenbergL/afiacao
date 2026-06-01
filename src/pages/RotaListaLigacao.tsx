import { useMemo } from 'react';
import { Phone, CheckCircle2 } from 'lucide-react';
import { useRouteContactList } from '@/queries/useRouteContactList';
import type { RouteContactItem } from '@/queries/useRouteContactList';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { CallButton } from '@/components/call/CallButton';
import { OutcomeMenu } from '@/components/call/OutcomeMenu';
import { RouteDisparoConfigPanel } from '@/components/rota/RouteDisparoConfigPanel';
import { spBusinessDate } from '@/lib/time/sp-day';

const BUCKET_LABEL: Record<string, string> = {
  top: 'Prioridade',
  winback: 'Recuperar',
  coldstart: 'Novo cliente',
};

function ResolvidosSection({ itens }: { itens: RouteContactItem[] }) {
  return (
    <Card className="p-3 border-status-success/40">
      <div className="text-xs uppercase tracking-wide text-status-success mb-2 flex items-center gap-1">
        <CheckCircle2 className="w-3.5 h-3.5" /> Resolvidos hoje ({itens.length})
      </div>
      <ul className="space-y-1">
        {itens.map((c) => (
          <li key={c.customerUserId} className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="w-3.5 h-3.5 text-status-success-bold shrink-0" />
            <span className="truncate">{c.name}</span>
            <span className="text-xs font-tabular">· {c.cityKey.city}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function RotaListaLigacao() {
  // data de NEGÓCIO em SP (não UTC — senão das ~21h às 24h locais a data vira o dia seguinte → rota errada).
  const workday = useMemo(() => spBusinessDate(new Date()), []);
  const { data, isLoading } = useRouteContactList(workday);

  if (isLoading) return <PageSkeleton variant="list" />;

  const cidadesLabel = data?.cidades?.length ? data.cidades.join(', ') : null;
  const routeDate = data?.routeDate ?? workday;

  if (!data || data.callQueue.length === 0) {
    return (
      <div className="p-4 space-y-3">
        <h1 className="font-display text-2xl">Lista de ligação por rota</h1>
        {data && data.resolvidosQueue.length > 0 && <ResolvidosSection itens={data.resolvidosQueue} />}
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

  const { ligados, atenderam, fecharam } = data.dailyStats;

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
        {ligados > 0 && (
          <p className="text-xs text-muted-foreground font-tabular mt-1">
            Hoje: {ligados} ligados · {atenderam} atenderam · {fecharam} fecharam
          </p>
        )}
        {data.cadenciaIndisponivel && (
          <p className="text-xs text-status-warning mt-1">
            Cadência ao vivo indisponível — a fila pode repetir contatos recentes.
          </p>
        )}
      </header>

      {data.resolvidosQueue.length > 0 && <ResolvidosSection itens={data.resolvidosQueue} />}

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
                  <div className="text-xs text-muted-foreground font-tabular flex items-center gap-2 flex-wrap">
                    <span>{c.cityKey.city}</span>
                    {c.ultimoContatoRealHaDias != null && <span>· contatado há {c.ultimoContatoRealHaDias}d</span>}
                    {c.semRespostaRecenteN > 0 && <span>· sem resposta {c.semRespostaRecenteN}×</span>}
                  </div>
                </div>
                {c.bucket && <Badge variant="secondary">{BUCKET_LABEL[c.bucket] ?? c.bucket}</Badge>}
                <span className="kpi-value text-sm w-24 text-right">R$ {Math.round(c.valorDaLigacao)}</span>
                {c.phone
                  ? <CallButton phone={c.phone} customerName={c.name} variant="icon" />
                  : <span className="text-xs text-muted-foreground w-8 text-center">—</span>}
                <OutcomeMenu
                  customerUserId={c.customerUserId}
                  customerName={c.name}
                  dataRota={routeDate}
                  bucket={c.bucket}
                  valor={c.valorDaLigacao}
                />
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}
