/**
 * Home do master = "Visão do CEO". Ordem (parecer Codex 2026-11-20):
 *   placar → pedem você → crescimento comparável → operação.
 * A operação (deltas + as 6 zonas do cockpit) continua inteira, só desce: o CEO abre o dia pelo
 * resultado e pelas decisões, não pela fila de NF e picking.
 */
import { CeoPlacar } from './CeoPlacar';
import { PriorityCard } from '../PriorityCard';
import { GestorExcecoes } from '../GestorExcecoes';
import { CrescimentoComparavelCard } from '../CrescimentoComparavelCard';
import { DeltasStrip } from '../DeltasStrip';
import { CockpitGrid } from '../CockpitGrid';
import type { PriorityCandidate } from '@/lib/dashboard/priority-rules';

const DATA_HOJE = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'America/Sao_Paulo',
});

function Secao({ titulo, children, id }: { titulo: string; children: React.ReactNode; id?: string }) {
  return (
    <section className="max-w-7xl mx-auto w-full px-4 lg:px-6 space-y-3" aria-labelledby={id ? `${id}-titulo` : undefined}>
      <h2 id={id ? `${id}-titulo` : undefined} className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
        {titulo}
      </h2>
      {children}
    </section>
  );
}

export function CeoVisao({ winner }: { winner: PriorityCandidate | null }) {
  return (
    <>
      <section className="bg-cockpit-hero noise relative overflow-hidden border-b border-border">
        <div className="relative max-w-7xl mx-auto px-4 lg:px-6 py-8 lg:py-10 space-y-5">
          <header>
            <p className="text-xs capitalize text-muted-foreground">{DATA_HOJE.format(new Date())}</p>
            <h1 className="font-display text-3xl tracking-tight">Visão do CEO</h1>
          </header>
          <CeoPlacar />
        </div>
      </section>

      <div className="flex-1 space-y-8 py-8">
        <Secao titulo="Pedem você" id="ceo-pedem-voce">
          <PriorityCard winner={winner} />
          <GestorExcecoes />
        </Secao>

        <Secao titulo="Crescimento" id="ceo-crescimento">
          <CrescimentoComparavelCard />
        </Secao>

        <Secao titulo="Operação" id="ceo-operacao">
          <DeltasStrip />
        </Secao>
        <main>
          <CockpitGrid />
        </main>
      </div>
    </>
  );
}
