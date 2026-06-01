import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { ShieldAlert } from 'lucide-react';
import { useDataHealth } from '@/hooks/useDataHealth';
import { rollupDomain, formatAge, badgeLevel, shouldShowDiagnostics } from '@/lib/dataHealth/health-helpers';

const DOMAIN_LABEL: Record<string, string> = {
  financeiro: 'Financeiro', omie_sync: 'Syncs Omie', carteira: 'Carteira / Scoring', estoque: 'Estoque / Reposição', vendas: 'Vendas / Pedidos', alertas: 'Canal de alerta',
};
const STATUS_CLS: Record<string, string> = {
  ok: 'text-status-success', stale: 'text-status-warning', broken: 'text-status-error', unknown: 'text-status-error',
};

export default function SaudeDados() {
  const { data, isLoading, isError } = useDataHealth();
  if (isLoading) return <PageSkeleton variant="list" />;

  if (isError || !data) {
    return (
      <div className="max-w-4xl mx-auto p-4">
        <EmptyState icon={ShieldAlert} title="Saúde de dados indisponível"
          description="Não foi possível computar os checks. Trate como NÃO confiável até resolver." tone="operational" />
      </div>
    );
  }

  const domains = rollupDomain(data);
  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="font-display" style={{ fontSize: '2rem', fontWeight: 500, letterSpacing: '-0.04em', lineHeight: 1.1 }}>
          Saúde de Dados
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Frescor e integridade das fontes que alimentam as decisões. Nível: {badgeLevel(data)}.
        </p>
      </div>
      {domains.map(d => (
        <Card key={d.domain}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <span className={STATUS_CLS[d.status]}>●</span>{DOMAIN_LABEL[d.domain] ?? d.domain}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {d.checks.map(c => (
              <div key={c.source} className="border-b last:border-0 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{c.message}</span>
                  <span className={`text-xs font-medium ${STATUS_CLS[c.status]}`}>
                    {c.status} · {formatAge(c.age_seconds)}
                  </span>
                </div>
                {shouldShowDiagnostics(c) && (
                  <>
                    {c.probable_cause && <p className="text-xs text-muted-foreground mt-0.5">Causa provável: {c.probable_cause}</p>}
                    {c.how_to_fix && <p className="text-xs text-status-info mt-0.5">Como resolver: {c.how_to_fix}</p>}
                    {c.last_error && <p className="text-xs text-status-error mt-0.5 font-mono">{c.last_error}</p>}
                  </>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
