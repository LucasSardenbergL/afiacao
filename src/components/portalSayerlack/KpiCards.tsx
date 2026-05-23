// Grid de 4 KPIs do Portal Sayerlack.
// Extraído de src/pages/AdminPortalSayerlack.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { PortalKpis } from './types';

export function KpiCards({ kpis }: { kpis?: PortalKpis }) {
  const pendCor = !kpis ? 'text-muted-foreground'
    : kpis.pendentes === 0 ? 'text-muted-foreground'
    : kpis.pendentes <= 2 ? 'text-status-info'
    : 'text-status-warning';
  const taxaCor = kpis?.taxa == null ? 'text-muted-foreground'
    : kpis.taxa >= 95 ? 'text-status-success'
    : kpis.taxa >= 80 ? 'text-status-warning'
    : 'text-status-error';
  const concilCor = !kpis ? 'text-muted-foreground'
    : kpis.conciliacao === 0 ? 'text-muted-foreground'
    : 'text-status-warning';

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Pendentes envio</CardTitle></CardHeader>
        <CardContent>
          <div className={`text-4xl font-bold ${pendCor}`}>{kpis?.pendentes ?? '—'}</div>
          <div className="text-xs text-muted-foreground mt-1">pedidos aguardando envio</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Enviados últimos 7d</CardTitle></CardHeader>
        <CardContent>
          <div className="text-4xl font-bold text-status-success">{kpis?.enviados7d ?? '—'}</div>
          <div className="text-xs text-muted-foreground mt-1">pedidos finalizados</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Taxa de sucesso 30d</CardTitle></CardHeader>
        <CardContent>
          <div className={`text-4xl font-bold ${taxaCor}`}>
            {kpis?.taxa == null ? '—' : `${String(kpis.taxa).replace('.', ',')}%`}
          </div>
          <div className="text-xs text-muted-foreground mt-1">enviados / (enviados+falhas)</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Requer conciliação</CardTitle></CardHeader>
        <CardContent>
          <div className={`text-4xl font-bold ${concilCor}`}>{kpis?.conciliacao ?? '—'}</div>
          <div className="text-xs text-muted-foreground mt-1">aceito sem protocolo / indeterminado</div>
        </CardContent>
      </Card>
    </div>
  );
}
