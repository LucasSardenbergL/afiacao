import { useEffect, useRef } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import { useCarteiraSaude } from '@/hooks/useCarteiraSaude';
import { statusCron, statusSync, statusCoverage, nivelAgregado } from '@/lib/carteira-saude/status';
import { track } from '@/lib/analytics';
import type { SaudeNivel } from '@/lib/carteira-saude/types';

const DOT: Record<SaudeNivel, string> = {
  green: 'bg-status-success-bold',
  yellow: 'bg-status-warning-bold',
  red: 'bg-status-error-bold',
};

const NIGHTLY_MAX_AGE = 48;
const MENSAL = 'carteira-positivacao-snapshot-mensal';

function Row({ nivel, label, detail, acao }: { nivel: SaudeNivel; label: string; detail: string; acao: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className={`mt-1 h-2.5 w-2.5 rounded-full shrink-0 ${DOT[nivel]}`} />
      <div className="min-w-0">
        <div className="text-sm font-medium">
          {label} <span className="text-2xs text-muted-foreground font-normal">{detail}</span>
        </div>
        {nivel !== 'green' && <div className="text-2xs text-muted-foreground">{acao}</div>}
      </div>
    </div>
  );
}

export function CarteiraSaudePanel() {
  const { data, isLoading } = useCarteiraSaude();

  const tracked = useRef(false);
  useEffect(() => {
    if (!data || tracked.current) return;
    tracked.current = true;
    const niveis = [
      ...data.crons.map((c) => statusCron(c, c.jobname === MENSAL ? null : NIGHTLY_MAX_AGE).nivel),
      statusSync(data.sync).nivel,
      statusCoverage(data.score_coverage).nivel,
    ];
    track('carteira.saude_vista', { nivel: nivelAgregado(niveis) });
  }, [data]);

  if (isLoading) {
    return (
      <Card className="p-6 flex justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </Card>
    );
  }
  if (!data) return null;

  const cronRows = data.crons.map((c) => {
    const st = statusCron(c, c.jobname === MENSAL ? null : NIGHTLY_MAX_AGE);
    const detail = c.last_run_at ? `${c.last_status ?? '?'} · há ${c.age_hours ?? '?'}h` : 'nunca rodou';
    return { ...st, label: c.jobname, detail };
  });
  const syncSt = statusSync(data.sync);
  const syncDetail = data.sync.age_hours == null
    ? 'sem sync'
    : `há ${data.sync.age_hours}h · ${data.sync.stale_count} stale`;
  const covSt = statusCoverage(data.score_coverage);
  const covDetail = `${data.score_coverage.fcs_clientes}/${data.score_coverage.carteira} score · ${data.score_coverage.cvs_clientes}/${data.score_coverage.carteira} visita`;

  const agregado = nivelAgregado([...cronRows.map((r) => r.nivel), syncSt.nivel, covSt.nivel]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${DOT[agregado]}`} />
          Saúde da carteira
        </CardTitle>
        <p className="text-2xs text-muted-foreground">
          Crons, frescor do sync Omie e cobertura de score. Semáforo operacional — vermelho = ação necessária.
        </p>
      </CardHeader>
      <div className="px-6 pb-4 divide-y divide-border">
        <Row nivel={syncSt.nivel} label="Sync da carteira" detail={syncDetail} acao={syncSt.acao} />
        <Row nivel={covSt.nivel} label="Cobertura de score" detail={covDetail} acao={covSt.acao} />
        {cronRows.map((r) => (
          <Row key={r.label} nivel={r.nivel} label={r.label} detail={r.detail} acao={r.acao} />
        ))}
      </div>
    </Card>
  );
}
