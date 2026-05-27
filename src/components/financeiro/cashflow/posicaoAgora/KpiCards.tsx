// Linha de KPIs do PosicaoAgora (Capital de Giro / CG Líquido / Projeção 30d / Ciclo).
// Extraída verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split).
import { TrendingUp, TrendingDown, Wallet, Target } from 'lucide-react';
import type { CapitalDeGiro } from '@/services/financeiroService';
import { fmtCompact } from './format';
import { MetricCard } from './MetricCard';

export function KpiCards({ active }: { active: CapitalDeGiro }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <MetricCard
        title="Capital de Giro"
        value={active.capital_giro}
        subtitle="CR - CP abertos"
        positive={active.capital_giro >= 0}
        icon={active.capital_giro >= 0 ? TrendingUp : TrendingDown}
      />
      <MetricCard
        title="CG Líquido"
        value={active.capital_giro_liquido}
        subtitle="CR + CC - CP"
        positive={active.capital_giro_liquido >= 0}
        icon={Wallet}
      />
      <MetricCard
        title="Projeção 30 dias"
        value={active.saldo_projetado_30d}
        subtitle={`+${fmtCompact(active.entradas_30d)} / -${fmtCompact(active.saidas_30d)}`}
        positive={active.saldo_projetado_30d >= 0}
        icon={Target}
      />
      <div className="p-4 rounded-lg border bg-card">
        <p className="text-xs text-muted-foreground font-medium">Ciclo Financeiro</p>
        {active.ciclo_financeiro === null ? (
          <>
            <p className="text-2xl font-bold mt-1 text-muted-foreground">—</p>
            <p className="text-xs text-muted-foreground mt-1">sem dados de prazo</p>
          </>
        ) : (
          <>
            <p className={`text-2xl font-bold mt-1 ${active.ciclo_financeiro > 0 ? 'text-status-warning' : 'text-status-success'}`}>
              {active.ciclo_financeiro} dias
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              PMR {active.pmr ?? '—'}d − PMP {active.pmp ?? '—'}d
            </p>
          </>
        )}
      </div>
    </div>
  );
}
