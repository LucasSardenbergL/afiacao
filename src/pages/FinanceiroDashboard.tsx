import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFinanceiro, type FinanceiroView } from '@/hooks/useFinanceiro';
import { useFinanceiroRegime } from '@/hooks/useFinanceiroRegime';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import {
  exportContasPagarCSV, exportContasReceberCSV, exportDRECSV, downloadCSV,
} from '@/services/financeiroService';
import {
  Loader2, RefreshCw, DollarSign, TrendingUp, TrendingDown,
  AlertTriangle, Wallet, ArrowDownCircle, ArrowUpCircle,
  Building2, BarChart3, Calendar,
  Clock, Download, History
} from 'lucide-react';
import { AuditTrailDrawer } from '@/components/financeiro/AuditTrailDrawer';
import { usePeriodLockHandler } from '@/components/financeiro/PeriodLockGuard';
import { generateAlerts } from '@/utils/financeiroAlerts';
import { RegimeToggle } from '@/components/financeiro/RegimeToggle';
import {
  fmt, fmtCompact, fmtDate, statusColor, formatCnpj,
} from '@/components/financeiro/dashboard/format';
import { KpiCard } from '@/components/financeiro/dashboard/KpiCard';
import { AgingCard } from '@/components/financeiro/dashboard/AgingCard';
import { FluxoCaixaTab } from '@/components/financeiro/dashboard/FluxoCaixaTab';
import { DRETab } from '@/components/financeiro/dashboard/DRETab';
import { DREComparativo } from '@/components/financeiro/dashboard/DREComparativo';

const today = new Date();
const sixMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 6, 1);
const threeMonthsAhead = new Date(today.getFullYear(), today.getMonth() + 3, 0);

// ═══════════════ MAIN COMPONENT ═══════════════

const FinanceiroDashboard = () => {
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
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Financeiro</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Controle financeiro integrado — Omie
            {lastSync && (
              <span className="ml-2 text-xs font-normal opacity-60">
                · Sync {new Date(lastSync).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </p>
        </div>
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
        <TabsList className="grid grid-cols-5 w-full">
          <TabsTrigger value="visao-geral" className="text-xs sm:text-sm">Visão Geral</TabsTrigger>
          <TabsTrigger value="contas-receber" className="text-xs sm:text-sm">A Receber</TabsTrigger>
          <TabsTrigger value="contas-pagar" className="text-xs sm:text-sm">A Pagar</TabsTrigger>
          <TabsTrigger value="fluxo-caixa" className="text-xs sm:text-sm">Fluxo Caixa</TabsTrigger>
          <TabsTrigger value="dre" className="text-xs sm:text-sm">DRE</TabsTrigger>
        </TabsList>

        {/* ═══════════ TAB: VISÃO GERAL ═══════════ */}
        <TabsContent value="visao-geral" className="space-y-4 mt-4">
          {/* Alerts */}
          {alerts.length > 0 && (
            <div className="space-y-2">
              {alerts.slice(0, 5).map((alert, i) => {
                const Icon = alert.icon;
                const bgColor = alert.severity === 'critical'
                  ? 'bg-status-error-bg border-status-error/30'
                  : alert.severity === 'warning'
                    ? 'bg-status-warning-bg border-status-warning/30'
                    : 'bg-status-info-bg border-status-info/30';
                const textColor = alert.severity === 'critical'
                  ? 'text-status-error'
                  : alert.severity === 'warning'
                    ? 'text-status-warning'
                    : 'text-status-info';
                return (
                  <div key={i} className={`flex items-start gap-3 p-3 rounded-lg border ${bgColor}`}>
                    <Icon className={`w-4 h-4 mt-0.5 ${textColor}`} />
                    <div>
                      <p className={`text-sm font-medium ${textColor}`}>{alert.message}</p>
                      {alert.metric && (
                        <p className={`text-xs mt-0.5 ${textColor} opacity-80`}>{alert.metric}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* KPI Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard
              title="A Receber"
              value={activeResumo?.total_a_receber || 0}
              icon={ArrowDownCircle}
              color="text-status-success"
              bgColor="bg-status-success-bg"
              subtitle={activeResumo?.total_vencido_receber 
                ? `${fmt(activeResumo.total_vencido_receber)} vencido` 
                : undefined}
              subtitleColor="text-status-error"
            />
            <KpiCard
              title="A Pagar"
              value={activeResumo?.total_a_pagar || 0}
              icon={ArrowUpCircle}
              color="text-status-error"
              bgColor="bg-status-error-bg"
              subtitle={activeResumo?.total_vencido_pagar
                ? `${fmt(activeResumo.total_vencido_pagar)} vencido`
                : undefined}
              subtitleColor="text-status-error"
            />
            <KpiCard
              title="Posição Líquida"
              value={activeResumo?.posicao_liquida || 0}
              icon={(activeResumo?.posicao_liquida || 0) >= 0 ? TrendingUp : TrendingDown}
              color={(activeResumo?.posicao_liquida || 0) >= 0 ? 'text-status-success' : 'text-status-error'}
              bgColor={(activeResumo?.posicao_liquida || 0) >= 0 ? 'bg-status-success-bg' : 'bg-status-error-bg'}
            />
            <KpiCard
              title="Saldo Bancário"
              value={activeResumo?.saldo_total_cc || 0}
              icon={Wallet}
              color="text-status-info"
              bgColor="bg-status-info-bg"
            />
          </div>

          {/* Breakdown por empresa (quando consolidado) */}
          {view === 'all' && Object.keys(resumo).length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Posição por Empresa</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {Object.entries(resumo).map(([co, r]) => (
                    <div key={co} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                      <div className="flex items-center gap-3">
                        <Badge variant="outline" className="font-medium">
                          {COMPANIES[co as Company]?.shortName || co}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-6 text-sm">
                        <div className="text-right">
                          <p className="text-muted-foreground text-xs">A Receber</p>
                          <p className="font-medium text-status-success">{fmtCompact(r.total_a_receber)}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-muted-foreground text-xs">A Pagar</p>
                          <p className="font-medium text-status-error">{fmtCompact(r.total_a_pagar)}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-muted-foreground text-xs">Líquida</p>
                          <p className={`font-bold ${r.posicao_liquida >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                            {fmtCompact(r.posicao_liquida)}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Aging */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <AgingCard title="Aging Recebíveis" data={agingReceber} type="receber" />
            <AgingCard title="Aging Payables" data={agingPagar} type="pagar" />
          </div>

          {/* CFO Indicators */}
          {activeResumo && agingReceber && agingPagar && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="w-4 h-4" />
                  Indicadores Financeiros
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {/* Capital de Giro */}
                  <div className="text-center p-3 rounded-lg bg-muted/40">
                    <p className="text-xs text-muted-foreground">Capital de Giro</p>
                    <p className={`text-lg font-bold mt-1 ${
                      (activeResumo.total_a_receber - activeResumo.total_a_pagar) >= 0 
                        ? 'text-status-success' : 'text-status-error'
                    }`}>
                      {fmtCompact(activeResumo.total_a_receber - activeResumo.total_a_pagar)}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">CR − CP abertos</p>
                  </div>
                  {/* Inadimplência % */}
                  <div className="text-center p-3 rounded-lg bg-muted/40">
                    <p className="text-xs text-muted-foreground">Inadimplência</p>
                    <p className={`text-lg font-bold mt-1 ${
                      activeResumo.total_a_receber > 0 && (activeResumo.total_vencido_receber / activeResumo.total_a_receber) > 0.15
                        ? 'text-status-error' : 'text-status-warning'
                    }`}>
                      {activeResumo.total_a_receber > 0
                        ? `${((activeResumo.total_vencido_receber / activeResumo.total_a_receber) * 100).toFixed(1)}%`
                        : '0%'}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Vencido / Total CR</p>
                  </div>
                  {/* Cobertura de Caixa */}
                  <div className="text-center p-3 rounded-lg bg-muted/40">
                    <p className="text-xs text-muted-foreground">Cobertura de Caixa</p>
                    <p className={`text-lg font-bold mt-1 ${
                      activeResumo.total_a_pagar > 0 && (activeResumo.saldo_total_cc / activeResumo.total_a_pagar) >= 0.5
                        ? 'text-status-success' : 'text-status-error'
                    }`}>
                      {activeResumo.total_a_pagar > 0
                        ? `${((activeResumo.saldo_total_cc / activeResumo.total_a_pagar) * 100).toFixed(0)}%`
                        : '—'}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Saldo CC / CP total</p>
                  </div>
                  {/* Exposure > 90 dias */}
                  <div className="text-center p-3 rounded-lg bg-muted/40">
                    <p className="text-xs text-muted-foreground">Risco +90 dias</p>
                    <p className={`text-lg font-bold mt-1 ${
                      agingReceber.vencido_90_plus_valor > 0 ? 'text-status-error' : 'text-status-success'
                    }`}>
                      {fmtCompact(agingReceber.vencido_90_plus_valor)}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{agingReceber.vencido_90_plus_qtd} título(s)</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Regime por empresa */}
          {view === 'all' && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Regime Tributário</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-3">
                  {ALL_COMPANIES.map(co => (
                    <div key={co} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50">
                      <span className="font-medium text-sm">{COMPANIES[co].shortName}</span>
                      <Badge variant="secondary" className="text-xs capitalize">
                        {COMPANIES[co].regime === 'simples' ? 'Simples Nacional' : 'Lucro Presumido'}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Top Inadimplentes */}
          {inadimplentes.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-status-error" />
                  Maiores Inadimplentes
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {inadimplentes.slice(0, 8).map((i, idx) => (
                    <div key={idx} className="flex items-center justify-between py-2 border-b last:border-0">
                      <div>
                        <p className="font-medium text-sm">{i.nome}</p>
                        <p className="text-xs text-muted-foreground">
                          {i.cnpj ? formatCnpj(i.cnpj) : '—'} · {i.qtd_titulos} título(s)
                        </p>
                      </div>
                      <span className="font-bold text-status-error text-sm">{fmt(i.total_vencido)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Contas Correntes */}
          {activeResumo && activeResumo.contas_correntes.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Wallet className="w-4 h-4 text-status-info" />
                  Contas Correntes
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {activeResumo.contas_correntes.map((cc, idx) => (
                    <div key={idx} className="flex items-center justify-between py-2 border-b last:border-0">
                      <div>
                        <p className="font-medium text-sm">{cc.descricao}</p>
                        <p className="text-xs text-muted-foreground">{cc.banco}</p>
                      </div>
                      <span className={`font-bold text-sm ${cc.saldo_atual >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                        {fmt(cc.saldo_atual)}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ═══════════ TAB: CONTAS A RECEBER ═══════════ */}
        <TabsContent value="contas-receber" className="space-y-4 mt-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex gap-2 flex-wrap">
              {['ABERTO', 'VENCIDO', 'RECEBIDO', 'PARCIAL'].map(s => (
                <Button
                  key={s}
                  variant={crFilter === s ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setCrFilter(s)}
                >
                  {s === 'ABERTO' && <Clock className="w-3.5 h-3.5 mr-1" />}
                  {s === 'VENCIDO' && <AlertTriangle className="w-3.5 h-3.5 mr-1" />}
                  {s === 'RECEBIDO' && <DollarSign className="w-3.5 h-3.5 mr-1" />}
                  {s}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={crDateFrom}
                onChange={e => setCrDateFrom(e.target.value)}
                className="h-8 rounded border px-2 text-xs"
                placeholder="De"
              />
              <input
                type="date"
                value={crDateTo}
                onChange={e => setCrDateTo(e.target.value)}
                className="h-8 rounded border px-2 text-xs"
                placeholder="Até"
              />
              {(crDateFrom || crDateTo) && (
                <Button variant="ghost" size="sm" onClick={() => { setCrDateFrom(''); setCrDateTo(''); }}>
                  Limpar
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{contasReceber.length} títulos</Badge>
              {contasReceber.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => {
                  const csv = exportContasReceberCSV(contasReceber);
                  downloadCSV(csv, `contas_receber_${view}_${crFilter}.csv`);
                }}>
                  <Download className="w-3.5 h-3.5 mr-1" />
                  CSV
                </Button>
              )}
            </div>
          </div>

          {/* Totalizadores */}
          {contasReceber.length > 0 && (
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 rounded-lg bg-muted/50 text-center">
                <p className="text-xs text-muted-foreground">Valor Total</p>
                <p className="text-sm font-bold">{fmt(crTotals.valor)}</p>
              </div>
              <div className="p-3 rounded-lg bg-status-success-bg text-center">
                <p className="text-xs text-muted-foreground">Recebido</p>
                <p className="text-sm font-bold text-status-success">{fmt(crTotals.recebido)}</p>
              </div>
              <div className="p-3 rounded-lg bg-status-info-bg text-center">
                <p className="text-xs text-muted-foreground">Saldo</p>
                <p className="text-sm font-bold text-status-info">{fmt(crTotals.saldo)}</p>
              </div>
            </div>
          )}

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {view === 'all' && <TableHead className="w-20">Empresa</TableHead>}
                      <TableHead>Cliente</TableHead>
                      <TableHead className="w-24">Vencimento</TableHead>
                      <TableHead className="text-right w-28">Valor</TableHead>
                      <TableHead className="text-right w-28">Recebido</TableHead>
                      <TableHead className="text-right w-28">Saldo</TableHead>
                      <TableHead className="w-20">Status</TableHead>
                      <TableHead>Categoria</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contasReceber.map((cr) => (
                      <TableRow key={cr.id}>
                        {view === 'all' && (
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {COMPANIES[cr.company as Company]?.shortName || cr.company}
                            </Badge>
                          </TableCell>
                        )}
                        <TableCell>
                          <div>
                            <p className="font-medium text-sm truncate max-w-[200px]">{cr.nome_cliente || '—'}</p>
                            {cr.numero_documento && (
                              <p className="text-xs text-muted-foreground">{cr.numero_documento}</p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{fmtDate(cr.data_vencimento)}</TableCell>
                        <TableCell className="text-right font-medium">{fmt(cr.valor_documento)}</TableCell>
                        <TableCell className="text-right text-status-success">{fmt(cr.valor_recebido)}</TableCell>
                        <TableCell className="text-right font-bold">{fmt(cr.saldo)}</TableCell>
                        <TableCell>
                          <Badge className={`text-xs ${statusColor(cr.status_titulo)}`}>
                            {cr.status_titulo}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground truncate max-w-[120px]">
                          {cr.categoria_descricao || cr.categoria_codigo || '—'}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              setAuditTarget({
                                table: 'fin_contas_receber',
                                id: cr.id,
                                title: `CR ${cr.nome_cliente || cr.numero_documento || cr.id}`,
                              });
                            }}
                            aria-label="Histórico"
                          >
                            <History className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {contasReceber.length === 0 && !loading && (
                      <TableRow>
                        <TableCell colSpan={view === 'all' ? 9 : 8} className="text-center py-8 text-muted-foreground">
                          Nenhum título encontrado. Sincronize os dados primeiro.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══════════ TAB: CONTAS A PAGAR ═══════════ */}
        <TabsContent value="contas-pagar" className="space-y-4 mt-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex gap-2 flex-wrap">
              {['ABERTO', 'VENCIDO', 'PAGO', 'PARCIAL'].map(s => (
                <Button
                  key={s}
                  variant={cpFilter === s ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setCpFilter(s)}
                >
                  {s === 'ABERTO' && <Clock className="w-3.5 h-3.5 mr-1" />}
                  {s === 'VENCIDO' && <AlertTriangle className="w-3.5 h-3.5 mr-1" />}
                  {s === 'PAGO' && <DollarSign className="w-3.5 h-3.5 mr-1" />}
                  {s}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={cpDateFrom}
                onChange={e => setCpDateFrom(e.target.value)}
                className="h-8 rounded border px-2 text-xs"
              />
              <input
                type="date"
                value={cpDateTo}
                onChange={e => setCpDateTo(e.target.value)}
                className="h-8 rounded border px-2 text-xs"
              />
              {(cpDateFrom || cpDateTo) && (
                <Button variant="ghost" size="sm" onClick={() => { setCpDateFrom(''); setCpDateTo(''); }}>
                  Limpar
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{contasPagar.length} títulos</Badge>
              {contasPagar.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => {
                  const csv = exportContasPagarCSV(contasPagar);
                  downloadCSV(csv, `contas_pagar_${view}_${cpFilter}.csv`);
                }}>
                  <Download className="w-3.5 h-3.5 mr-1" />
                  CSV
                </Button>
              )}
            </div>
          </div>

          {/* Totalizadores */}
          {contasPagar.length > 0 && (
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 rounded-lg bg-muted/50 text-center">
                <p className="text-xs text-muted-foreground">Valor Total</p>
                <p className="text-sm font-bold">{fmt(cpTotals.valor)}</p>
              </div>
              <div className="p-3 rounded-lg bg-status-success-bg text-center">
                <p className="text-xs text-muted-foreground">Pago</p>
                <p className="text-sm font-bold text-status-success">{fmt(cpTotals.pago)}</p>
              </div>
              <div className="p-3 rounded-lg bg-status-error-bg text-center">
                <p className="text-xs text-muted-foreground">Saldo</p>
                <p className="text-sm font-bold text-status-error">{fmt(cpTotals.saldo)}</p>
              </div>
            </div>
          )}

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {view === 'all' && <TableHead className="w-20">Empresa</TableHead>}
                      <TableHead>Fornecedor</TableHead>
                      <TableHead className="w-24">Vencimento</TableHead>
                      <TableHead className="text-right w-28">Valor</TableHead>
                      <TableHead className="text-right w-28">Pago</TableHead>
                      <TableHead className="text-right w-28">Saldo</TableHead>
                      <TableHead className="w-20">Status</TableHead>
                      <TableHead>Categoria</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contasPagar.map((cp) => (
                      <TableRow key={cp.id}>
                        {view === 'all' && (
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {COMPANIES[cp.company as Company]?.shortName || cp.company}
                            </Badge>
                          </TableCell>
                        )}
                        <TableCell>
                          <div>
                            <p className="font-medium text-sm truncate max-w-[200px]">{cp.nome_fornecedor || '—'}</p>
                            {cp.numero_documento && (
                              <p className="text-xs text-muted-foreground">{cp.numero_documento}</p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{fmtDate(cp.data_vencimento)}</TableCell>
                        <TableCell className="text-right font-medium">{fmt(cp.valor_documento)}</TableCell>
                        <TableCell className="text-right text-status-success">{fmt(cp.valor_pago)}</TableCell>
                        <TableCell className="text-right font-bold">{fmt(cp.saldo)}</TableCell>
                        <TableCell>
                          <Badge className={`text-xs ${statusColor(cp.status_titulo)}`}>
                            {cp.status_titulo}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground truncate max-w-[120px]">
                          {cp.categoria_descricao || cp.categoria_codigo || '—'}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              setAuditTarget({
                                table: 'fin_contas_pagar',
                                id: cp.id,
                                title: `CP ${cp.nome_fornecedor || cp.numero_documento || cp.id}`,
                              });
                            }}
                            aria-label="Histórico"
                          >
                            <History className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {contasPagar.length === 0 && !loading && (
                      <TableRow>
                        <TableCell colSpan={view === 'all' ? 9 : 8} className="text-center py-8 text-muted-foreground">
                          Nenhum título encontrado. Sincronize os dados primeiro.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
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
