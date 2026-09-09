// Tab de Fluxo de Caixa (visão semanal) do dashboard financeiro.
// Extraído de src/pages/FinanceiroDashboard.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { BarChart3 } from 'lucide-react';
import { fmtCompact } from '@/components/financeiro/dashboard/format';
import { agruparSemanasFluxo } from '@/components/financeiro/dashboard/fluxo-caixa-semanas';
import { spBusinessDate } from '@/lib/time/sp-day';
import type { FluxoCaixaDiario } from '@/services/financeiroService';

export function FluxoCaixaTab({ data, loading, saldoCC }: {
  data: FluxoCaixaDiario[];
  loading: boolean;
  /** `null`/ausente = saldo bancário indisponível: a projeção fica sem âncora e degrada. */
  saldoCC?: number | null;
}) {
  if (loading) return <Skeleton className="h-60" />;
  if (!data || data.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          <BarChart3 className="w-10 h-10 mx-auto mb-3 opacity-40" />
          Nenhum dado de fluxo de caixa. Sincronize os dados primeiro.
        </CardContent>
      </Card>
    );
  }

  // Data de NEGÓCIO em São Paulo. `toISOString()` é UTC: das 21h à meia-noite locais o "hoje"
  // já era o dia seguinte, e a fronteira passado/futuro — que é o que separa o dinheiro já
  // dentro do `saldoCC` do que ainda vai entrar — saía deslocada em 3h todas as noites.
  const todayStr = spBusinessDate(new Date());

  // Separar passado (realizado) e futuro (previsto)
  const totalEntradasRealizadas = data.reduce((s, d) => s + (d.entradas_realizadas || 0), 0);
  const totalSaidasRealizadas = data.reduce((s, d) => s + (d.saidas_realizadas || 0), 0);
  const totalEntradasPrevistas = data
    .filter(d => d.data >= todayStr)
    .reduce((s, d) => s + (d.entradas_previstas || 0), 0);
  const totalSaidasPrevistas = data
    .filter(d => d.data >= todayStr)
    .reduce((s, d) => s + (d.saidas_previstas || 0), 0);

  // Agrupamento e projeção: função pura, testada sem render (ver fluxo-caixa-semanas.ts).
  const semanas = agruparSemanasFluxo(data, { hoje: todayStr, saldoCC: saldoCC ?? null });

  // Recorte da tabela: a semana CORRENTE em diante — é nela que o dono decide os pagamentos
  // da semana. (Antes era `slice(-12)`, que na prática dava o mesmo por acidente da janela,
  // mas escorregava para o passado sempre que o horizonte futuro tinha menos de 12 semanas.)
  const horizonte = semanas.filter(s => s.projetada);
  const visiveis = horizonte.length > 0 ? horizonte.slice(0, 12) : semanas.slice(-12);

  const maxVal = Math.max(...visiveis.map(w => Math.max(w.entradas, w.saidas)), 1);

  return (
    <div className="space-y-4">
      {/* Summary KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="p-3 rounded-lg bg-status-info-bg text-center">
          <p className="text-xs text-muted-foreground">Saldo CC Atual</p>
          <p className={`text-sm font-bold ${saldoCC == null ? 'text-muted-foreground' : 'text-status-info'}`}>
            {saldoCC == null ? '—' : fmtCompact(saldoCC)}
          </p>
        </div>
        <div className="p-3 rounded-lg bg-status-success-bg text-center">
          <p className="text-xs text-muted-foreground">Recebido</p>
          <p className="text-sm font-bold text-status-success">{fmtCompact(totalEntradasRealizadas)}</p>
        </div>
        <div className="p-3 rounded-lg bg-status-error-bg text-center">
          <p className="text-xs text-muted-foreground">Pago</p>
          <p className="text-sm font-bold text-status-error">{fmtCompact(totalSaidasRealizadas)}</p>
        </div>
        <div className="p-3 rounded-lg bg-status-success-bg/50 text-center">
          <p className="text-xs text-muted-foreground">Previsto Entrar</p>
          <p className="text-sm font-bold text-status-success">{fmtCompact(totalEntradasPrevistas)}</p>
        </div>
        <div className="p-3 rounded-lg bg-status-error-bg/50 text-center">
          <p className="text-xs text-muted-foreground">Previsto Sair</p>
          <p className="text-sm font-bold text-status-error">{fmtCompact(totalSaidasPrevistas)}</p>
        </div>
      </div>

      {/* Weekly chart */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Fluxo de Caixa Semanal</CardTitle>
          {saldoCC == null ? (
            <p className="text-xs text-status-warning">
              Saldo bancário indisponível — sem âncora não há saldo projetado (coluna em "—").
              Entradas e saídas previstas seguem válidas.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Saldo projetado a partir do saldo em conta de hoje ({fmtCompact(saldoCC)}) — só o que
              ainda não aconteceu entra na conta.
            </p>
          )}
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {visiveis.map((w, i) => (
              <div key={i} className="grid grid-cols-[80px_1fr_80px_80px] items-center gap-2 text-sm">
                <span className="text-xs text-muted-foreground truncate">{w.label}</span>
                <div className="relative h-6">
                  <div
                    className="absolute top-0 h-3 rounded bg-status-success/70"
                    style={{ width: `${(w.entradas / maxVal) * 100}%` }}
                  />
                  <div
                    className="absolute bottom-0 h-3 rounded bg-status-error/70"
                    style={{ width: `${(w.saidas / maxVal) * 100}%` }}
                  />
                </div>
                <span className={`text-right text-xs font-bold ${w.saldo >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                  {fmtCompact(w.saldo)}
                </span>
                <span className={`text-right text-[10px] ${
                  w.acumulado === null ? 'text-muted-foreground'
                    : w.acumulado >= 0 ? 'text-status-info' : 'text-status-error'
                }`}>
                  {w.acumulado === null ? '—' : fmtCompact(w.acumulado)}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-4 mt-4 justify-center text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-status-success/70" /> Entradas</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-status-error/70" /> Saídas</span>
            <span>Saldo semanal</span>
            <span className="text-status-info">Saldo projetado</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
