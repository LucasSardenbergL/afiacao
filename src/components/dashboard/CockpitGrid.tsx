import { useEffect, useRef } from 'react';
import { VendasZone } from './zones/VendasZone';
import { EstoqueZone } from './zones/EstoqueZone';
import { ReposicaoZone } from './zones/ReposicaoZone';
import { FinanceiroZone } from './zones/FinanceiroZone';
import { TintometricoZone } from './zones/TintometricoZone';
import { SistemaZone } from './zones/SistemaZone';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';
import { PERSONA_CONFIG, type ZoneId } from '@/lib/dashboard/persona-config';
import { cn } from '@/lib/utils';

const ZONE_COMPONENTS: Record<ZoneId, () => JSX.Element> = {
  vendas: VendasZone,
  estoque: EstoqueZone,
  reposicao: ReposicaoZone,
  financeiro: FinanceiroZone,
  tintometrico: TintometricoZone,
  sistema: SistemaZone,
};

export function CockpitGrid() {
  const { persona } = useDashboardPersonaContext();
  const order = PERSONA_CONFIG[persona].zoneOrder;

  // Refs pros atalhos 1..6 (scroll-to + outline temporário)
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= 6) {
        const ref = refs.current[n - 1];
        if (!ref) return;
        ref.scrollIntoView({ behavior: 'smooth', block: 'center' });
        ref.classList.add('ring-2', 'ring-foreground/20');
        setTimeout(() => ref?.classList.remove('ring-2', 'ring-foreground/20'), 1200);
      }
    };
    // Atenção: o ShortcutsRegistry filtra inputs; pra 1-6 simples usamos listener direto.
    // Verifica se foco está em input pra não conflitar:
    const guarded = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return handler(e);
      const tag = target.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target.isContentEditable) return;
      handler(e);
    };
    window.addEventListener('keydown', guarded);
    return () => window.removeEventListener('keydown', guarded);
  }, []);

  return (
    <section
      id="cockpit-grid"
      className={cn(
        'max-w-7xl mx-auto px-4 lg:px-6 py-6 lg:py-8',
        'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4',
      )}
    >
      {order.map((zoneId, i) => {
        const Comp = ZONE_COMPONENTS[zoneId];
        return (
          <div key={zoneId} ref={(el) => (refs.current[i] = el)} className="rounded-lg transition-shadow">
            <Comp />
          </div>
        );
      })}
    </section>
  );
}
