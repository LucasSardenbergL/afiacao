import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CoorteMes } from '@/hooks/useFinanceiroCiclo';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import {
  JANELAS_MATURACAO, celulaMaturacao, montarLinhasMaturacao, type CoorteMaturacao, type LinhaMaturacao,
} from '@/lib/financeiro/coorte-maturacao-helpers';
import { montarSerieTendencia, type PontoTendencia as Ponto } from './ciclo-format';

/** Ponto de mês parcial = círculo vazio (aberto); mês fechado = círculo cheio. */
function DotReal(props: { cx?: number; cy?: number; payload?: Ponto }) {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || !payload || payload.real === null) return <g />;
  return payload.parcial
    ? <circle cx={cx} cy={cy} r={4} fill="hsl(var(--background))" stroke="hsl(var(--primary))" strokeWidth={2} strokeDasharray="2 2" />
    : <circle cx={cx} cy={cy} r={3} fill="hsl(var(--primary))" />;
}

/** Maturação de UM mês para o tooltip: "D+15 21,1% · D+30 …" (com "piso" quando há pago sem data), ou imatura. */
function maturacaoDoMes(linhas: LinhaMaturacao[], rotulo: string): string {
  const l = linhas.find((x) => x.rotulo === rotulo);
  if (!l) return 'maturação indisponível';
  if (!l.maduro[15]) return 'coorte imatura (D+15 ainda aberto)';
  const partes = JANELAS_MATURACAO.map((j) => `D+${j} ${celulaMaturacao(l.pct[j])}`).join(' · ');
  return l.temSemData ? `${partes} (piso: há pago sem data de baixa)` : partes;
}

export function CicloTendencia({ coorte, company, maturacao, maturacaoErro, maturacaoCarregando }: {
  coorte: CoorteMes[]; company: Company;
  maturacao: CoorteMaturacao[]; maturacaoErro: boolean; maturacaoCarregando: boolean;
}) {
  const serie = montarSerieTendencia(coorte, company);
  // Erro na leitura: NENHUMA superfície publica (nem o tooltip com o cache antigo — Codex, 2026-11-01).
  const linhas = maturacaoErro ? [] : montarLinhasMaturacao(maturacao, company);
  return (
    <Card data-testid={`ciclo-tendencia-${company}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{COMPANIES[company].shortName} — prazo por mês de vencimento</CardTitle>
        <p className="text-xs text-muted-foreground">
          * e círculo vazio = mês cortado pela janela (primeiro/último). Maturação da coorte = % do valor vencido no mês pago até
          D+15/30/60 após o vencimento, com o título contando pelo valor integral na data da última baixa (não é recebimento parcial
          acumulado); uma janela só publica número quando todos os títulos do mês já passaram por ela.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {serie.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sem coorte para esta empresa.</p>
        ) : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={serie}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} unit="d" />
                <Tooltip
                  formatter={(v: unknown) => (typeof v === 'number' ? `${v.toFixed(1)}d` : '—')}
                  labelFormatter={(rotulo: unknown, itens) => {
                    const p = itens?.[0]?.payload as Ponto | undefined;
                    const mes = String(rotulo).replace(/\*$/, '');
                    return `${String(rotulo)} — ${maturacaoDoMes(linhas, mes)}${p?.parcial ? ' (mês parcial)' : ''}`;
                  }}
                />
                <Legend />
                <Line type="monotone" dataKey="concedido" name="Concedido" stroke="hsl(var(--muted-foreground))" dot={false} connectNulls={false} />
                <Line type="monotone" dataKey="real" name="Real (pagas)" stroke="hsl(var(--primary))" dot={<DotReal />} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Coortes com maturação fixa (Frente A, item 4): imatura = "—", nunca número parcial; % é PISO. */}
        {maturacaoErro && (
          <p className="text-status-error text-sm" data-testid={`ciclo-maturacao-erro-${company}`}>
            Não foi possível ler a maturação das coortes.
          </p>
        )}
        {!maturacaoErro && maturacaoCarregando && <p className="text-xs text-muted-foreground">Lendo a maturação das coortes…</p>}
        {!maturacaoErro && !maturacaoCarregando && linhas.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid={`ciclo-maturacao-${company}`}>
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="py-1 pr-2 font-medium">Vencimento</th>
                  <th className="py-1 pr-2 font-medium text-right">Vencido</th>
                  {JANELAS_MATURACAO.map((j) => (
                    <th
                      key={j}
                      className="py-1 pr-2 font-medium text-right"
                      title={`% do valor vencido no mês pago até ${j} dias após o vencimento (título pelo valor integral na data da última baixa; piso, sem arredondar para cima)`}
                    >
                      D+{j}
                    </th>
                  ))}
                  <th className="py-1 pr-2 font-medium text-right" title="Pago antes do vencimento (nunca somado ao atraso)">Antecip.</th>
                  <th className="py-1 pr-2 font-medium text-right" title="Dias de atraso ponderados por valor, só dos títulos pagos com atraso">Atraso</th>
                  <th className="py-1 font-medium text-right" title="Saldo das vencidas ainda em aberto">Em aberto</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l) => (
                  <tr key={l.mes} className="border-t border-border" data-testid={`ciclo-maturacao-${company}-${l.rotulo}`}>
                    <td className="py-1 pr-2 tabular-nums">
                      {l.rotulo}
                      {l.parcial && (
                        <span className="text-muted-foreground" title="mês cortado pela janela de 365 d: a coorte é um recorte, não o mês inteiro" data-testid={`ciclo-maturacao-${company}-${l.rotulo}-parcial`}>*</span>
                      )}
                      {l.temSemData && (
                        <span className="text-muted-foreground" title={`${l.pctSemData.toFixed(1)}% do valor pago sem data de baixa: os D+N são piso`} data-testid={`ciclo-maturacao-${company}-${l.rotulo}-piso`}> †</span>
                      )}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{l.titulos} tít.</td>
                    {JANELAS_MATURACAO.map((j) => (
                      <td
                        key={j}
                        className={`py-1 pr-2 text-right tabular-nums ${l.maduro[j] ? '' : 'text-muted-foreground'}`}
                        title={l.maduro[j] ? undefined : `coorte imatura: o último vencimento do mês + ${j} dias ainda não passou`}
                        data-testid={`ciclo-maturacao-${company}-${l.rotulo}-d${j}`}
                      >
                        {celulaMaturacao(l.pct[j])}
                      </td>
                    ))}
                    <td className="py-1 pr-2 text-right tabular-nums">{l.pctAntecipado.toFixed(1)}%</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{l.diasAtrasoPond === null ? '—' : `${l.diasAtrasoPond.toFixed(0)}d`}</td>
                    <td className="py-1 text-right tabular-nums">{l.pctEmAberto.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {linhas.some((l) => l.temSemData) && (
              <p className="mt-1 text-xs text-muted-foreground">† parte do valor pago não tem data de baixa legível: nesses meses os D+N são piso.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
