// Cockpit financeiro — visão consolidada (caixa, margens, DRE, projeção, inadimplência).
// Composição: useFinanceiroCockpit (dados/derivados) + header + KPIs + cards de seção.
// God-component split de src/pages/FinanceiroCockpit.tsx (comportamento 1:1).
import { Skeleton } from '@/components/ui/skeleton';
import { TrendingUp, TrendingDown, Wallet, Target } from 'lucide-react';
import { CockpitDrillDown } from '@/components/financeiro/CockpitDrillDown';
import { PeriodOverrideHistory } from '@/components/financeiro/PeriodOverrideHistory';
import { useFinanceiroCockpit } from '@/components/financeiro/cockpit/useFinanceiroCockpit';
import { fmtCompact } from '@/components/financeiro/cockpit/format';
import { CockpitHeader } from '@/components/financeiro/cockpit/CockpitHeader';
import { CockpitCard } from '@/components/financeiro/cockpit/CockpitCard';
import { MiniCard } from '@/components/financeiro/cockpit/MiniCard';
import { ResultadoPorEmpresa } from '@/components/financeiro/cockpit/ResultadoPorEmpresa';
import { Projecao13Card } from '@/components/financeiro/cockpit/Projecao13Card';
import { TopInadimplentes } from '@/components/financeiro/cockpit/TopInadimplentes';
import { DataBasisFooter } from '@/components/financeiro/cockpit/DataBasisFooter';
import { FleurietBadge } from '@/components/financeiro/cockpit/FleurietBadge';
import { BalancoInputDialog } from '@/components/financeiro/cockpit/BalancoInputDialog';
import { useAuth } from '@/contexts/AuthContext';

const EMPRESA_LABEL: Record<string, string> = { oben: 'Oben', colacor: 'Colacor', colacor_sc: 'Colacor SC' };
const EMPRESAS = ['oben', 'colacor', 'colacor_sc'] as const;

const FinanceiroCockpit = () => {
  const {
    loading,
    regime,
    recarregar,
    confiabilidade,
    dreConsolidado,
    cockpit,
    fleuriet,
    inadimplentes,
    drillDown,
    setDrillDown,
    totalCC,
    totalCR,
    totalCP,
    totalVencidoCR,
    ncg,
    pctInadimplencia,
    margemBruta,
    margemOp,
    riscoLiquidez,
    riscoLabel,
    riscoColor,
    pctCritico,
    agingCriticoValor,
  } = useFinanceiroCockpit();
  const { isMaster } = useAuth();

  if (loading) {
    return (
      <div className="space-y-4 pb-24">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-3 gap-3">{[1,2,3].map(i => <Skeleton key={i} className="h-28" />)}</div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-24">
      {/* Header — display serif Newsreader em h1 + atmosphere gradient sutil + noise */}
      <CockpitHeader confiabilidade={confiabilidade} />

      {/* Row 1: Big 3 — staggered reveal pra page load orquestrado */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 stagger-children">
        <CockpitCard
          title="Caixa Disponível"
          value={fmtCompact(totalCC)}
          positive={totalCC > 0}
          icon={Wallet}
          detail={`Risco de liquidez: ${riscoLabel} (${(riscoLiquidez * 100).toFixed(0)}%)`}
          detailColor={riscoColor}
          badge="Saldo bancário real"
          onClick={() => setDrillDown('caixa')}
        />
        <CockpitCard
          title="Posição líquida (abertos)"
          value={fmtCompact(totalCC + totalCR - totalCP)}
          positive={totalCC + totalCR - totalCP > 0}
          icon={Target}
          detail={`+ ${fmtCompact(totalCR)} a receber / - ${fmtCompact(totalCP)} a pagar (abertos)`}
          badge="CR+CC−CP abertos · não é projeção"
          onClick={() => setDrillDown('cr_aberto')}
        />
        <CockpitCard
          title="Necessidade de CG"
          value={fmtCompact(ncg)}
          positive={ncg <= 0}
          icon={ncg <= 0 ? TrendingUp : TrendingDown}
          detail={cockpit.ncg_parcial
            ? `Parcial: ${cockpit.empresas_presentes.length}/3 empresas`
            : ncg <= 0 ? 'PCO financia a operação (folga)' : 'Operação imobiliza capital de giro'}
          detailColor={ncg <= 0 ? 'text-status-success' : 'text-status-warning'}
          badge={cockpit.ncg_parcial ? `ACO−PCO (engine) · ${cockpit.empresas_presentes.length}/3` : 'ACO − PCO (engine A1)'}
          onClick={() => setDrillDown('cr_aberto')}
        />
      </div>

      {/* Cobertura estrutural do giro (Fleuriet): selos (quando há balanço) + inputs master-only */}
      {(isMaster || EMPRESAS.some((co) => fleuriet[co]?.data_balanco != null)) && (
        <div className="flex flex-wrap items-center gap-2">
          {EMPRESAS.map((co) => fleuriet[co]?.data_balanco != null && (
            <FleurietBadge key={co} c={fleuriet[co]} empresaLabel={EMPRESA_LABEL[co]} />
          ))}
          {isMaster && EMPRESAS.map((co) => (
            <BalancoInputDialog key={`bal-${co}`} company={co} empresaLabel={EMPRESA_LABEL[co]} onSaved={recarregar} />
          ))}
        </div>
      )}

      {/* Row 2: Margens + Inadimplência + Risco — também staggered */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 stagger-children">
        <MiniCard label="Margem Bruta" value={`${margemBruta.toFixed(1)}%`}
          color={margemBruta >= 30 ? 'text-status-success' : 'text-status-warning'} />
        <MiniCard label="Margem Operacional" value={`${margemOp.toFixed(1)}%`}
          color={margemOp >= 10 ? 'text-status-success' : margemOp >= 0 ? 'text-status-warning' : 'text-status-error'} />
        <MiniCard label="Inadimplência" value={`${pctInadimplencia.toFixed(1)}%`}
          color={pctInadimplencia <= 10 ? 'text-status-success' : pctInadimplencia <= 25 ? 'text-status-warning' : 'text-status-error'}
          subtitle={fmtCompact(totalVencidoCR)}
          onClick={() => setDrillDown('inadimplencia')} />
        <MiniCard label="Aging Crítico (+60d)" value={`${pctCritico.toFixed(1)}%`}
          color={pctCritico <= 5 ? 'text-status-success' : pctCritico <= 15 ? 'text-status-warning' : 'text-status-error'}
          subtitle={fmtCompact(agingCriticoValor)}
          onClick={() => setDrillDown('aging_critico')} />
      </div>

      {/* Row 3: Resultado por empresa */}
      <ResultadoPorEmpresa dreConsolidado={dreConsolidado} confiabilidade={confiabilidade} />

      {/* Row 4: Projeção 13 semanas (engine A1 via snapshot, consolidada) */}
      {cockpit.projecao13.length > 0 && (
        <Projecao13Card
          projecao13={cockpit.projecao13}
          dataReferencia={cockpit.data_referencia}
          parcial={cockpit.parcial}
          empresasPresentes={cockpit.empresas_presentes}
          empresasAusentes={cockpit.empresas_ausentes}
          empresasStale={cockpit.empresas_stale}
          caixaInicialProjecao={cockpit.caixa_inicial_projecao}
          saldoAtualBanco={totalCC}
          cohorteCompleta={!cockpit.parcial}
        />
      )}

      {/* Row 5: Top inadimplentes */}
      {inadimplentes.length > 0 && (
        <TopInadimplentes inadimplentes={inadimplentes} />
      )}

      {/* Period override history */}
      <PeriodOverrideHistory />

      {/* Data basis footer */}
      <DataBasisFooter regime={regime} />

      <CockpitDrillDown type={drillDown} onClose={() => setDrillDown(null)} />
    </div>
  );
};

export default FinanceiroCockpit;
