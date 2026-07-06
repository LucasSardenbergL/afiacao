import { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useFinanceiro, type FinanceiroView } from '@/hooks/useFinanceiro';
import { useFinanceiroRegime } from '@/hooks/useFinanceiroRegime';
import { COMPANIES, ALL_COMPANIES } from '@/contexts/CompanyContext';
import { exportDRECSV, downloadCSV } from '@/services/financeiroService';
import {
  Loader2, RefreshCw, Building2, Calendar, Download,
} from 'lucide-react';
import { AuditTrailDrawer } from '@/components/financeiro/AuditTrailDrawer';
import { usePeriodLockHandler } from '@/components/financeiro/PeriodLockGuard';
import { generateAlerts } from '@/utils/financeiroAlerts';
import { RegimeToggle } from '@/components/financeiro/RegimeToggle';
import { FluxoCaixaTab } from '@/components/financeiro/dashboard/FluxoCaixaTab';
import { DRETab } from '@/components/financeiro/dashboard/DRETab';
import { DREComparativo } from '@/components/financeiro/dashboard/DREComparativo';
import { VisaoGeralTab } from '@/components/financeiro/dashboard/VisaoGeralTab';
import { ContasReceberTab } from '@/components/financeiro/dashboard/ContasReceberTab';
import { ContasPagarTab } from '@/components/financeiro/dashboard/ContasPagarTab';
import { ConcentracaoTab } from '@/components/financeiro/dashboard/ConcentracaoTab';
import { useAuth } from '@/contexts/AuthContext';

const today = new Date();
const sixMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 6, 1);
const threeMonthsAhead = new Date(today.getFullYear(), today.getMonth() + 3, 0);

// ═══════════════ MAIN COMPONENT ═══════════════

const FinanceiroDashboard = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const {
    view, setView, loading, syncing, error, lastSync,
    activeResumo, resumo,
    contasPagar, contasReceber,
    agingReceber, agingPagar,
    dreConsolidado, drePorEmpresa,
    fluxoCaixa, inadimplentes,
    loadResumo, loadContasPagar, loadContasReceber,
    loadAging, loadDRE, loadFluxoCaixa, loadInadimplentes,
    syncAll, calcularDRE, calcularDREAnual,
  } = useFinanceiro('all');

  const { regime } = useFinanceiroRegime();
  const { isMaster } = useAuth();
  const lockHandler = usePeriodLockHandler();

  const [tab, setTab] = useState('visao-geral');
  const [cpFilter, setCpFilter] = useState('ABERTO');
  const [crFilter, setCrFilter] = useState('ABERTO');
  const [dreAno, setDreAno] = useState(today.getFullYear());
  const [crDateFrom, setCrDateFrom] = useState('');
  const [crDateTo, setCrDateTo] = useState('');
  const [cpDateFrom, setCpDateFrom] = useState('');
  const [cpDateTo, setCpDateTo] = useState('');
  const [auditTarget, setAuditTarget] = useState<{ table: string; id: string; title: string } | null>(null);

  // Financial alerts
  const alerts = useMemo(() => {
    if (Object.keys(resumo).length === 0) return [];
    return generateAlerts(resumo, agingReceber, agingPagar);
  }, [resumo, agingReceber, agingPagar]);

  // Summary totals for CP/CR
  const crTotals = useMemo(() => ({
    valor: contasReceber.reduce((s, r) => s + r.valor_documento, 0),
    recebido: contasReceber.reduce((s, r) => s + r.valor_recebido, 0),
    saldo: contasReceber.reduce((s, r) => s + r.saldo, 0),
  }), [contasReceber]);

  const cpTotals = useMemo(() => ({
    valor: contasPagar.reduce((s, r) => s + r.valor_documento, 0),
    pago: contasPagar.reduce((s, r) => s + r.valor_pago, 0),
    saldo: contasPagar.reduce((s, r) => s + r.saldo, 0),
  }), [contasPagar]);

  // Initial load
  useEffect(() => {
    loadResumo();
    loadAging();
    loadInadimplentes();
  }, [view]);

  // Tab-specific loads
  useEffect(() => {
    if (tab === 'contas-pagar') loadContasPagar({
      status: cpFilter,
      limit: 500,
      ...(cpDateFrom ? { dataInicio: cpDateFrom } : {}),
      ...(cpDateTo ? { dataFim: cpDateTo } : {}),
    });
    if (tab === 'contas-receber') loadContasReceber({
      status: crFilter,
      limit: 500,
      ...(crDateFrom ? { dataInicio: crDateFrom } : {}),
      ...(crDateTo ? { dataFim: crDateTo } : {}),
    });
    if (tab === 'fluxo-caixa') {
      loadFluxoCaixa(
        sixMonthsAgo.toISOString().slice(0, 10),
        threeMonthsAhead.toISOString().slice(0, 10)
      );
    }
    if (tab === 'dre') loadDRE(dreAno, undefined, regime);
  }, [tab, view, cpFilter, crFilter, dreAno, regime, crDateFrom, crDateTo, cpDateFrom, cpDateTo, loadDRE]);

  return (
    <div className="space-y-4 pb-24">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        {/* Título omitido quando embutido (ex: dentro de FinanceiroGestao, que já tem h1) */}
        {!embedded && (
          <div>
            <h1
              className="font-display"
              style={{ fontSize: "2rem", fontWeight: 500, letterSpacing: "-0.04em", lineHeight: 1.1 }}
            >
              Financeiro
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Controle financeiro integrado — Omie
              {lastSync && (
                <span className="ml-2 text-xs font-normal opacity-60">
                  · Sync {new Date(lastSync).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </p>
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <RegimeToggle />
          <Select value={view} onValueChange={(v) => setView(v as FinanceiroView)}>
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
          <Button
            variant="outline"
            size="sm"
            onClick={syncAll}
            disabled={syncing}
          >
            {syncing ? (
              <Loader2 className="w-4 h-4 animate-spin mr-1" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-1" />
            )}
            Sincronizar
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-status-error-bg border border-status-error/30 rounded-lg p-3 text-sm text-status-error">
          {error}
        </div>
      )}

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className={isMaster ? 'grid grid-cols-6 w-full' : 'grid grid-cols-5 w-full'}>
          <TabsTrigger value="visao-geral" className="text-xs sm:text-sm">Visão Geral</TabsTrigger>
          <TabsTrigger value="contas-receber" className="text-xs sm:text-sm">A Receber</TabsTrigger>
          <TabsTrigger value="contas-pagar" className="text-xs sm:text-sm">A Pagar</TabsTrigger>
          <TabsTrigger value="fluxo-caixa" className="text-xs sm:text-sm">Fluxo Caixa</TabsTrigger>
          <TabsTrigger value="dre" className="text-xs sm:text-sm">DRE</TabsTrigger>
          {isMaster && (
            <TabsTrigger value="concentracao" className="text-xs sm:text-sm">Concentração</TabsTrigger>
          )}
        </TabsList>

        {/* ═══════════ TAB: VISÃO GERAL ═══════════ */}
        <TabsContent value="visao-geral" className="space-y-4 mt-4">
          <VisaoGeralTab
            alerts={alerts}
            activeResumo={activeResumo}
            resumo={resumo}
            view={view}
            agingReceber={agingReceber}
            agingPagar={agingPagar}
            inadimplentes={inadimplentes}
          />
        </TabsContent>

        {/* ═══════════ TAB: CONTAS A RECEBER ═══════════ */}
        <TabsContent value="contas-receber" className="space-y-4 mt-4">
          <ContasReceberTab
            crFilter={crFilter}
            setCrFilter={setCrFilter}
            crDateFrom={crDateFrom}
            setCrDateFrom={setCrDateFrom}
            crDateTo={crDateTo}
            setCrDateTo={setCrDateTo}
            contasReceber={contasReceber}
            crTotals={crTotals}
            view={view}
            loading={loading}
            onAudit={setAuditTarget}
          />
        </TabsContent>

        {/* ═══════════ TAB: CONTAS A PAGAR ═══════════ */}
        <TabsContent value="contas-pagar" className="space-y-4 mt-4">
          <ContasPagarTab
            cpFilter={cpFilter}
            setCpFilter={setCpFilter}
            cpDateFrom={cpDateFrom}
            setCpDateFrom={setCpDateFrom}
            cpDateTo={cpDateTo}
            setCpDateTo={setCpDateTo}
            contasPagar={contasPagar}
            cpTotals={cpTotals}
            view={view}
            loading={loading}
            onAudit={setAuditTarget}
          />
        </TabsContent>

        {/* ═══════════ TAB: FLUXO DE CAIXA ═══════════ */}
        <TabsContent value="fluxo-caixa" className="space-y-4 mt-4">
          <FluxoCaixaTab data={fluxoCaixa} loading={loading} saldoCC={activeResumo?.saldo_total_cc} />
        </TabsContent>

        {/* ═══════════ TAB: DRE ═══════════ */}
        <TabsContent value="dre" className="space-y-4 mt-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <Select value={String(dreAno)} onValueChange={v => setDreAno(Number(v))}>
              <SelectTrigger className="w-[120px]">
                <Calendar className="w-4 h-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[2024, 2025, 2026].map(y => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => calcularDREAnual(dreAno, regime)}
                disabled={syncing}
              >
                {syncing ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
                Recalcular Ano
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const now = new Date();
                  calcularDRE(now.getFullYear(), now.getMonth() + 1, regime);
                }}
                disabled={syncing}
              >
                Recalcular Mês Atual
              </Button>
              {dreConsolidado.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const csv = exportDRECSV(dreConsolidado);
                    downloadCSV(csv, `dre_${view === 'all' ? 'consolidado' : view}_${dreAno}.csv`);
                  }}
                >
                  <Download className="w-3.5 h-3.5 mr-1" />
                  CSV
                </Button>
              )}
            </div>
          </div>

          <DRETab data={dreConsolidado} view={view} ano={dreAno} />

          {/* Comparativo por empresa quando consolidado */}
          {view === 'all' && Object.keys(drePorEmpresa).length > 1 && (
            <DREComparativo data={drePorEmpresa} ano={dreAno} />
          )}
        </TabsContent>

        {/* ═══════════ TAB: CONCENTRAÇÃO (F5 — master-only) ═══════════ */}
        {isMaster && (
          <TabsContent value="concentracao" className="space-y-4 mt-4">
            <ConcentracaoTab />
          </TabsContent>
        )}
      </Tabs>

      {loading && (
        <div className="fixed bottom-20 right-4 bg-primary text-primary-foreground px-3 py-2 rounded-full shadow-lg flex items-center gap-2 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Carregando...
        </div>
      )}

      {auditTarget && (
        <AuditTrailDrawer
          open
          onOpenChange={(open) => !open && setAuditTarget(null)}
          tableName={auditTarget.table}
          rowId={auditTarget.id}
          title={auditTarget.title}
        />
      )}

      {lockHandler.modal}
    </div>
  );
};

export default FinanceiroDashboard;
