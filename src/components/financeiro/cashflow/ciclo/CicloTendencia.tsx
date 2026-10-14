import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CoorteMes } from '@/hooks/useFinanceiroCiclo';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import { montarSerieTendencia, type PontoTendencia as Ponto } from './ciclo-format';

/** Ponto de mês parcial = círculo vazio (aberto); mês fechado = círculo cheio. */
function DotReal(props: { cx?: number; cy?: number; payload?: Ponto }) {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || !payload || payload.real === null) return <g />;
  return payload.parcial
    ? <circle cx={cx} cy={cy} r={4} fill="hsl(var(--background))" stroke="hsl(var(--primary))" strokeWidth={2} strokeDasharray="2 2" />
    : <circle cx={cx} cy={cy} r={3} fill="hsl(var(--primary))" />;
}

export function CicloTendencia({ coorte, company }: { coorte: CoorteMes[]; company: Company }) {
  const serie = montarSerieTendencia(coorte, company);
  return (
    <Card data-testid={`ciclo-tendencia-${company}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{COMPANIES[company].shortName} — prazo por mês de vencimento</CardTitle>
        <p className="text-xs text-muted-foreground">
          * e círculo vazio = mês parcial (primeiro/último da janela). Coortes recentes têm parte ainda em aberto (% pago no tooltip) e parecem melhores do que são.
        </p>
      </CardHeader>
      <CardContent className="h-56">
        {serie.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sem coorte para esta empresa.</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={serie}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} unit="d" />
              <Tooltip
                formatter={(v: unknown) => (typeof v === 'number' ? `${v.toFixed(1)}d` : '—')}
                labelFormatter={(rotulo: unknown, itens) => {
                  const p = itens?.[0]?.payload as Ponto | undefined;
                  const pago = p?.pago;
                  return `${String(rotulo)} — ${pago == null ? '—' : `${pago}%`} do valor já pago${p?.parcial ? ' (mês parcial)' : ''}`;
                }}
              />
              <Legend />
              <Line type="monotone" dataKey="concedido" name="Concedido" stroke="hsl(var(--muted-foreground))" dot={false} connectNulls={false} />
              <Line type="monotone" dataKey="real" name="Real (pagas)" stroke="hsl(var(--primary))" dot={<DotReal />} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
