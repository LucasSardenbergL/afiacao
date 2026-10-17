import { ROTULOS } from '@/lib/reposicao/raio-x/classificar';
import type { Placar } from '@/lib/reposicao/raio-x/placar';
import { fmtReais } from './formato';

/** Placar da mercadoria parada. "Distorce o DIO" fica AO LADO do total — nunca somado a ele. */
export function RaioXPlacar({ placar }: { placar: Placar }) {
  const pct = placar.total > 0 ? Math.min(100, Math.round((placar.decidido / placar.total) * 100)) : 0;
  const destinos = Object.entries(placar.porDestino).filter(([, v]) => (v ?? 0) > 0);
  return (
    <section aria-label="Placar do Raio-X" className="grid gap-3 md:grid-cols-[2fr_1fr]">
      <div className="space-y-2 rounded-md border p-4">
        <div data-testid="placar-total" className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-display text-2xl">{fmtReais(placar.decidido)}</span>
          <span className="text-sm text-muted-foreground">decidido de {fmtReais(placar.total)} de mercadoria parada</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-status-success" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-muted-foreground">
          Top 61: {fmtReais(placar.topDecidido)} decidido de {fmtReais(placar.topTotal)}
        </p>
        {destinos.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {destinos.map(([d, v]) => (
              <li key={d}>{ROTULOS[d] ?? d}: <span className="font-medium">{fmtReais(v ?? 0)}</span></li>
            ))}
          </ul>
        )}
        {placar.semCustoN > 0 && (
          <p className="text-xs text-status-warning">
            {placar.semCustoN} SKU(s) parado(s) sem custo — não avaliado (fora do total)
          </p>
        )}
      </div>
      <div data-testid="placar-dio" className="rounded-md border p-4">
        <div className="font-display text-xl">{fmtReais(placar.distorceDio)}</div>
        <p className="text-sm text-muted-foreground">R$ que distorce o DIO</p>
        <p className="text-xs text-muted-foreground">Não-mercadoria + uso e consumo. Não entra no total ao lado.</p>
      </div>
    </section>
  );
}
