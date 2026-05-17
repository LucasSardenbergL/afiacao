import { useNavigate } from 'react-router-dom';
import { useLastVisit } from '@/hooks/useLastVisit';
import { useBriefDeltas } from '@/hooks/dashboard/useBriefDeltas';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';
import { formatDeltaBullet, formatTimeSince, shouldHideStrip } from '@/lib/dashboard/delta-aggregators';
import { track } from '@/lib/analytics';

export function DeltasStrip() {
  const navigate = useNavigate();
  const { persona } = useDashboardPersonaContext();
  const { lastVisitIso, minutesSinceLastVisit } = useLastVisit();
  const { deltas, isLoading, isEmpty } = useBriefDeltas(persona);

  // Primeiro acesso
  if (!lastVisitIso) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mx-auto max-w-3xl text-center text-xs text-muted-foreground py-2"
      >
        Bem-vindo. Comece pelo cockpit abaixo.
      </div>
    );
  }

  if (shouldHideStrip(minutesSinceLastVisit)) return null;

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl text-center text-xs text-muted-foreground py-2 font-mono opacity-60">
        Calculando deltas…
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="mx-auto max-w-3xl text-center text-xs text-muted-foreground py-2">
        Sem mudanças desde sua última visita ({formatTimeSince(minutesSinceLastVisit ?? 0)}).
      </div>
    );
  }

  const handleClick = (type: string, value: number, path: string) => {
    track('dashboard.brief.delta_clicked', { delta_type: type, count: value });
    navigate(path);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto max-w-4xl text-center text-xs py-2 px-4 overflow-x-auto"
    >
      <span className="text-muted-foreground">
        Desde sua última visita ({formatTimeSince(minutesSinceLastVisit ?? 0)})
      </span>
      {deltas.map((d) => {
        const text = formatDeltaBullet(d);
        if (!text) return null;
        return (
          <span key={d.type} className="inline-flex items-center">
            <span className="text-muted-foreground mx-2">•</span>
            <button
              onClick={() => handleClick(d.type, d.value, d.path)}
              className="font-mono text-foreground hover:underline transition-colors"
            >
              {text}
            </button>
          </span>
        );
      })}
    </div>
  );
}
