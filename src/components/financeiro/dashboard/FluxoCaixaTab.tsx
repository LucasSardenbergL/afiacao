// Tab de Fluxo de Caixa (visão semanal) do dashboard financeiro.
// Extraído de src/pages/FinanceiroDashboard.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { BarChart3 } from 'lucide-react';
import { fmtCompact, getWeekLabel } from '@/components/financeiro/dashboard/format';
import type { FluxoCaixaDiario } from '@/services/financeiroService';

export function FluxoCaixaTab({ data, loading, saldoCC }: { data: FluxoCaixaDiario[]; loading: boolean; saldoCC?: number }) {
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

  const todayStr = new Date().toISOString().slice(0, 10);

  // Separar passado (realizado) e futuro (previsto)
  const totalEntradasRealizadas = data.reduce((s, d) => s + (d.entradas_realizadas || 0), 0);
  const totalSaidasRealizadas = data.reduce((s, d) => s + (d.saidas_realizadas || 0), 0);
  const totalEntradasPrevistas = data
    .filter(d => d.data >= todayStr)
    .reduce((s, d) => s + (d.entradas_previstas || 0), 0);
  const totalSaidasPrevistas = data
    .filter(d => d.data >= todayStr)
    .reduce((s, d) => s + (d.saidas_previstas || 0), 0);

  // Agrupar por semana para simplificar visualização
  const weeks: { label: string; entradas: number; saidas: number; saldo: number; acumulado: number }[] = [];
  let weekEntradas = 0, weekSaidas = 0;
  let currentWeek = '';
  let acumulado = saldoCC || 0;

  for (const day of data) {
    const d = new Date(day.data + 'T00:00:00');
    const weekNum = getWeekLabel(d);
    if (weekNum !== currentWeek && currentWeek !== '') {
      acumulado += weekEntradas - weekSaidas;
      weeks.push({ label: currentWeek, entradas: weekEntradas, saidas: weekSaidas, saldo: weekEntradas - weekSaidas, acumulado });
      weekEntradas = 0;
      weekSaidas = 0;
    }
    currentWeek = weekNum;
    const isPast = day.data < todayStr;
    weekEntradas += isPast ? (day.entradas_realizadas || 0) : (day.entradas_previstas || 0);
    weekSaidas += isPast ? (day.saidas_realizadas || 0) : (day.saidas_previstas || 0);
  }
  if (currentWeek) {
    acumulado += weekEntradas - weekSaidas;
    weeks.push({ label: currentWeek, entradas: weekEntradas, saidas: weekSaidas, saldo: weekEntradas - weekSaidas, acumulado });
  }

  const maxVal = Math.max(...weeks.map(w => Math.max(w.entradas, w.saidas)), 1);

  return (
    <div className="space-y-4">
      {/* Summary KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {saldoCC != null && (
          <div className="p-3 rounded-lg bg-status-info-bg text-center">
            <p className="text-xs text-muted-foreground">Saldo CC Atual</p>
            <p className="text-sm font-bold text-status-info">{fmtCompact(saldoCC)}</p>
          </div>
        )}
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
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {weeks.slice(-12).map((w, i) => (
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
                <span className={`text-right text-[10px] ${w.acumulado >= 0 ? 'text-status-info' : 'text-status-error'}`}>
                  {fmtCompact(w.acumulado)}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-4 mt-4 justify-center text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-status-success/70" /> Entradas</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-status-error/70" /> Saídas</span>
            <span>Saldo semanal</span>
            <span className="text-status-info">Acumulado</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
