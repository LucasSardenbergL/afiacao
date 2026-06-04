import { Loader2, BarChart3 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useMinhasVisitasResultado } from '@/hooks/useMinhasVisitasResultado';
import { agruparVisitasPorResultado } from '@/lib/visitas/conversao';
import { visitResultLabel } from '@/lib/visitas/visit-result';
import { formatBRL, formatPctMaybe } from '@/components/customer360/format';

const JANELA_DIAS = 90;

const toneBar: Record<string, string> = {
  success: 'bg-status-success',
  info: 'bg-status-info',
  error: 'bg-status-error',
  warning: 'bg-status-warning',
  muted: 'bg-muted-foreground/40',
};
const toneText: Record<string, string> = {
  success: 'text-status-success',
  info: 'text-status-info',
  error: 'text-status-error',
  warning: 'text-status-warning',
  muted: 'text-muted-foreground',
};

/**
 * Breakdown das visitas do vendedor logado por resultado (últimos 90 dias) + receita.
 * Read-only, own-scoped. Self-hide quando não há visita na janela.
 */
export function MinhasVisitasResultadoCard() {
  const { data, isLoading } = useMinhasVisitasResultado(JANELA_DIAS);

  if (isLoading) {
    return (
      <Card className="p-3 flex items-center text-xs text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />Carregando resultado das visitas…
      </Card>
    );
  }

  const resumo = agruparVisitasPorResultado(data ?? []);
  if (resumo.total === 0) return null; // self-hide

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <BarChart3 className="w-4 h-4 text-muted-foreground" />
          Resultado das suas visitas
          <span className="text-2xs text-muted-foreground font-normal">· {JANELA_DIAS} dias</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {resumo.total} visita{resumo.total > 1 ? 's' : ''}
          {resumo.receitaTotal > 0 && <span className="text-status-success font-medium"> · {formatBRL(resumo.receitaTotal)}</span>}
        </div>
      </div>

      <div className="space-y-1.5">
        {resumo.buckets.map((b) => {
          const r = visitResultLabel(b.result === 'sem_resultado' ? null : b.result);
          return (
            <div key={b.result} className="space-y-0.5">
              <div className="flex items-center justify-between text-xs">
                <span className={`font-medium ${toneText[r.tone]}`}>{r.emoji} {r.label}</span>
                <span className="text-muted-foreground">
                  {b.count} ({formatPctMaybe(b.pct)})
                  {b.revenue > 0 && <span className="text-status-success"> · {formatBRL(b.revenue)}</span>}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div className={`h-full ${toneBar[r.tone]}`} style={{ width: `${Math.round(b.pct * 100)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
