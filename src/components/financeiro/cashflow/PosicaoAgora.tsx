// Posição de caixa "agora" — liquidez, ciclo financeiro, projeção 30d e stress test.
// Composição: usePosicaoAgora (dados/consolidação) + filtro + cards de seção.
// God-component split de src/components/financeiro/cashflow/PosicaoAgora.tsx (comportamento 1:1).
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import { Building2 } from 'lucide-react';
import { usePosicaoAgora } from './posicaoAgora/usePosicaoAgora';
import { KpiCards } from './posicaoAgora/KpiCards';
import { CicloFinanceiroCard } from './posicaoAgora/CicloFinanceiroCard';
import { DsoDpoCard } from './posicaoAgora/DsoDpoCard';
import { Projecao30dCard } from './posicaoAgora/Projecao30dCard';
import { ComparativoEmpresasCard } from './posicaoAgora/ComparativoEmpresasCard';
import { ConcentracaoRiscoCard } from './posicaoAgora/ConcentracaoRiscoCard';
import { StressTest } from './posicaoAgora/StressTest';

export function PosicaoAgora() {
  const { data, loading, view, setView, active } = usePosicaoAgora();

  if (loading) {
    return (
      <div className="space-y-4 pb-24">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-24">
      {/* Filtro de empresa */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-muted-foreground">
          Análise de liquidez, ciclo financeiro e projeções
        </p>
        <Select value={view} onValueChange={v => setView(v as 'all' | Company)}>
          <SelectTrigger className="w-[180px]">
            <Building2 className="w-4 h-4 mr-2" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Consolidado</SelectItem>
            {ALL_COMPANIES.map(co => (
              <SelectItem key={co} value={co}>{COMPANIES[co].shortName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!active ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Sem dados. Sincronize o financeiro primeiro.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* KPI Cards */}
          <KpiCards active={active} />

          {/* Ciclo Financeiro Visual */}
          <CicloFinanceiroCard active={active} />

          {/* Lente contábil agregada (DSO/DPO) — só colacor (liquida em lote → PMR/PMP em "—") */}
          {active.company === 'colacor' && <DsoDpoCard />}

          {/* Projeção 30 dias */}
          <Projecao30dCard active={active} />

          {/* Comparativo por empresa */}
          {view === 'all' && data.length > 1 && (
            <ComparativoEmpresasCard data={data} />
          )}

          {/* Concentração de risco */}
          {active.top5_cr_pct > 0 && (
            <ConcentracaoRiscoCard active={active} />
          )}

          {/* Stress Test */}
          {active && (
            <StressTest
              saldoCC={active.saldo_cc}
              entradas30={active.entradas_30d}
              saidas30={active.saidas_30d}
              totalCR={active.total_cr_aberto}
              pmr={active.pmr ?? 0}
            />
          )}
        </>
      )}
    </div>
  );
}
