import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useFinanceiro, type FinanceiroView } from '@/hooks/useFinanceiro';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import {
  exportContasPagarCSV, exportContasReceberCSV, exportDRECSV, downloadCSV,
} from '@/services/financeiroService';
import {
  Loader2, RefreshCw, DollarSign, TrendingUp, TrendingDown,
  AlertTriangle, Wallet, ArrowDownCircle, ArrowUpCircle,
  Building2, BarChart3, PieChart, Calendar, FileText,
  ChevronDown, ChevronUp, Clock, Ban, Download, ShieldAlert
} from 'lucide-react';
import { generateAlerts } from '@/utils/financeiroAlerts';

// ═══════════════ FORMATTERS ═══════════════

const fmt = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtCompact = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${(v / 1_000).toFixed(1)}k`;
  return fmt(v);
};

const fmtDate = (d: string | null) => {
  if (!d) return '—';
  const date = new Date(d + 'T00:00:00');
  return date.toLocaleDateString('pt-BR');
};

const statusColor = (s: string) => {
  switch (s) {
    case 'PAGO': case 'RECEBIDO': case 'LIQUIDADO': return 'bg-emerald-100 text-emerald-700';
    case 'VENCIDO': return 'bg-red-100 text-red-700';
    case 'PARCIAL': return 'bg-amber-100 text-amber-700';
    case 'CANCELADO': return 'bg-gray-100 text-gray-500';
    default: return 'bg-blue-100 text-blue-700';
  }
};

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
    dre, dreConsolidado, drePorEmpresa,
    fluxoCaixa, inadimplentes,
    loadResumo, loadContasPagar, loadContasReceber,
    loadAging, loadDRE, loadFluxoCaixa, loadInadimplentes,
    syncAll, syncSpecific, calcularDRE, calcularDREAnual,
  } = useFinanceiro('all');

  const [tab, setTab] = useState('visao-geral');
  const [cpFilter, setCpFilter] = useState('ABERTO');
  const [crFilter, setCrFilter] = useState('ABERTO');
  const [dreAno, setDreAno] = useState(today.getFullYear());
  const [crDateFrom, setCrDateFrom] = useState('');
  const [crDateTo, setCrDateTo] = useState('');
  const [cpDateFrom, setCpDateFrom] = useState('');
  const [cpDateTo, setCpDateTo] = useState('');

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
    if (tab === 'dre') loadDRE(dreAno);
  }, [tab, view, cpFilter, crFilter, dreAno, crDateFrom, crDateTo, cpDateFrom, cpDateTo]);

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
        <div className="flex items-center gap-2">
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
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
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
                  ? 'bg-red-50 border-red-200'
                  : alert.severity === 'warning'
                    ? 'bg-amber-50 border-amber-200'
                    : 'bg-blue-50 border-blue-200';
                const textColor = alert.severity === 'critical'
                  ? 'text-red-700'
                  : alert.severity === 'warning'
                    ? 'text-amber-700'
                    : 'text-blue-700';
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
              color="text-emerald-600"
              bgColor="bg-emerald-50"
              subtitle={activeResumo?.total_vencido_receber 
                ? `${fmt(activeResumo.total_vencido_receber)} vencido` 
                : undefined}
              subtitleColor="text-red-500"
            />
            <KpiCard
              title="A Pagar"
              value={activeResumo?.total_a_pagar || 0}
              icon={ArrowUpCircle}
              color="text-red-600"
              bgColor="bg-red-50"
              subtitle={activeResumo?.total_vencido_pagar
                ? `${fmt(activeResumo.total_vencido_pagar)} vencido`
                : undefined}
              subtitleColor="text-red-500"
            />
            <KpiCard
              title="Posição Líquida"
              value={activeResumo?.posicao_liquida || 0}
              icon={(activeResumo?.posicao_liquida || 0) >= 0 ? TrendingUp : TrendingDown}
              color={(activeResumo?.posicao_liquida || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}
              bgColor={(activeResumo?.posicao_liquida || 0) >= 0 ? 'bg-emerald-50' : 'bg-red-50'}
            />
            <KpiCard
              title="Saldo Bancário"
              value={activeResumo?.saldo_total_cc || 0}
              icon={Wallet}
              color="text-blue-600"
              bgColor="bg-blue-50"
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
                          <p className="font-medium text-emerald-600">{fmtCompact(r.total_a_receber)}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-muted-foreground text-xs">A Pagar</p>
                          <p className="font-medium text-red-600">{fmtCompact(r.total_a_pagar)}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-muted-foreground text-xs">Líquida</p>
                          <p className={`font-bold ${r.posicao_liquida >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
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
                        ? 'text-emerald-600' : 'text-red-600'
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
                        ? 'text-red-600' : 'text-amber-600'
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
                        ? 'text-emerald-600' : 'text-red-600'
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
                      agingReceber.vencido_90_plus_valor > 0 ? 'text-red-600' : 'text-emerald-600'
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
                  <AlertTriangle className="w-4 h-4 text-red-500" />
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
                      <span className="font-bold text-red-600 text-sm">{fmt(i.total_vencido)}</span>
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
                  <Wallet className="w-4 h-4 text-blue-500" />
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
                      <span className={`font-bold text-sm ${cc.saldo_atual >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
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
              <div className="p-3 rounded-lg bg-emerald-50 text-center">
                <p className="text-xs text-muted-foreground">Recebido</p>
                <p className="text-sm font-bold text-emerald-600">{fmt(crTotals.recebido)}</p>
              </div>
              <div className="p-3 rounded-lg bg-blue-50 text-center">
                <p className="text-xs text-muted-foreground">Saldo</p>
                <p className="text-sm font-bold text-blue-600">{fmt(crTotals.saldo)}</p>
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
                        <TableCell className="text-right text-emerald-600">{fmt(cr.valor_recebido)}</TableCell>
                        <TableCell className="text-right font-bold">{fmt(cr.saldo)}</TableCell>
                        <TableCell>
                          <Badge className={`text-xs ${statusColor(cr.status_titulo)}`}>
                            {cr.status_titulo}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground truncate max-w-[120px]">
                          {cr.categoria_descricao || cr.categoria_codigo || '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                    {contasReceber.length === 0 && !loading && (
                      <TableRow>
                        <TableCell colSpan={view === 'all' ? 8 : 7} className="text-center py-8 text-muted-foreground">
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
              <div className="p-3 rounded-lg bg-emerald-50 text-center">
                <p className="text-xs text-muted-foreground">Pago</p>
                <p className="text-sm font-bold text-emerald-600">{fmt(cpTotals.pago)}</p>
              </div>
              <div className="p-3 rounded-lg bg-red-50 text-center">
                <p className="text-xs text-muted-foreground">Saldo</p>
                <p className="text-sm font-bold text-red-600">{fmt(cpTotals.saldo)}</p>
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
                        <TableCell className="text-right text-emerald-600">{fmt(cp.valor_pago)}</TableCell>
                        <TableCell className="text-right font-bold">{fmt(cp.saldo)}</TableCell>
                        <TableCell>
                          <Badge className={`text-xs ${statusColor(cp.status_titulo)}`}>
                            {cp.status_titulo}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground truncate max-w-[120px]">
                          {cp.categoria_descricao || cp.categoria_codigo || '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                    {contasPagar.length === 0 && !loading && (
                      <TableRow>
                        <TableCell colSpan={view === 'all' ? 8 : 7} className="text-center py-8 text-muted-foreground">
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
                onClick={() => calcularDREAnual(dreAno)}
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
                  calcularDRE(now.getFullYear(), now.getMonth() + 1);
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
    </div>
  );
};

// ═══════════════ SUB-COMPONENTS ═══════════════

function KpiCard({ title, value, icon: Icon, color, bgColor, subtitle, subtitleColor }: {
  title: string;
  value: number;
  icon: any;
  color: string;
  bgColor: string;
  subtitle?: string;
  subtitleColor?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground font-medium">{title}</p>
            <p className={`text-lg font-bold mt-1 ${color}`}>{fmtCompact(value)}</p>
            {subtitle && (
              <p className={`text-xs mt-1 ${subtitleColor || 'text-muted-foreground'}`}>{subtitle}</p>
            )}
          </div>
          <div className={`p-2 rounded-lg ${bgColor}`}>
            <Icon className={`w-4 h-4 ${color}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AgingCard({ title, data, type }: { title: string; data: any; type: 'receber' | 'pagar' }) {
  if (!data) return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent><Skeleton className="h-40" /></CardContent>
    </Card>
  );

  const total =
    data.a_vencer_valor +
    data.vencido_1_30_valor +
    data.vencido_31_60_valor +
    data.vencido_61_90_valor +
    data.vencido_90_plus_valor;

  const bars = [
    { label: 'A vencer', value: data.a_vencer_valor, qtd: data.a_vencer_qtd, color: 'bg-blue-500' },
    { label: '1-30 dias', value: data.vencido_1_30_valor, qtd: data.vencido_1_30_qtd, color: 'bg-amber-500' },
    { label: '31-60 dias', value: data.vencido_31_60_valor, qtd: data.vencido_31_60_qtd, color: 'bg-orange-500' },
    { label: '61-90 dias', value: data.vencido_61_90_valor, qtd: data.vencido_61_90_qtd, color: 'bg-red-500' },
    { label: '+90 dias', value: data.vencido_90_plus_valor, qtd: data.vencido_90_plus_qtd, color: 'bg-red-700' },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">Total: {fmt(total)}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {bars.map(b => (
          <div key={b.label} className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">{b.label} ({b.qtd})</span>
              <span className="font-medium">{fmtCompact(b.value)}</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full ${b.color} transition-all`}
                style={{ width: total > 0 ? `${Math.max((b.value / total) * 100, 1)}%` : '0%' }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function FluxoCaixaTab({ data, loading, saldoCC }: { data: any[]; loading: boolean; saldoCC?: number }) {
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
          <div className="p-3 rounded-lg bg-blue-50 text-center">
            <p className="text-xs text-muted-foreground">Saldo CC Atual</p>
            <p className="text-sm font-bold text-blue-600">{fmtCompact(saldoCC)}</p>
          </div>
        )}
        <div className="p-3 rounded-lg bg-emerald-50 text-center">
          <p className="text-xs text-muted-foreground">Recebido</p>
          <p className="text-sm font-bold text-emerald-600">{fmtCompact(totalEntradasRealizadas)}</p>
        </div>
        <div className="p-3 rounded-lg bg-red-50 text-center">
          <p className="text-xs text-muted-foreground">Pago</p>
          <p className="text-sm font-bold text-red-600">{fmtCompact(totalSaidasRealizadas)}</p>
        </div>
        <div className="p-3 rounded-lg bg-emerald-50/50 text-center">
          <p className="text-xs text-muted-foreground">Previsto Entrar</p>
          <p className="text-sm font-bold text-emerald-500">{fmtCompact(totalEntradasPrevistas)}</p>
        </div>
        <div className="p-3 rounded-lg bg-red-50/50 text-center">
          <p className="text-xs text-muted-foreground">Previsto Sair</p>
          <p className="text-sm font-bold text-red-500">{fmtCompact(totalSaidasPrevistas)}</p>
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
                    className="absolute top-0 h-3 rounded bg-emerald-400/70"
                    style={{ width: `${(w.entradas / maxVal) * 100}%` }}
                  />
                  <div
                    className="absolute bottom-0 h-3 rounded bg-red-400/70"
                    style={{ width: `${(w.saidas / maxVal) * 100}%` }}
                  />
                </div>
                <span className={`text-right text-xs font-bold ${w.saldo >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {fmtCompact(w.saldo)}
                </span>
                <span className={`text-right text-[10px] ${w.acumulado >= 0 ? 'text-blue-600' : 'text-red-600'}`}>
                  {fmtCompact(w.acumulado)}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-4 mt-4 justify-center text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-400/70" /> Entradas</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-400/70" /> Saídas</span>
            <span>Saldo semanal</span>
            <span className="text-blue-600">Acumulado</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DRETab({ data, view, ano }: { data: any[]; view: FinanceiroView; ano: number }) {
  if (!data || data.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
          Nenhum DRE calculado para {ano}. Clique em "Recalcular" para gerar.
        </CardContent>
      </Card>
    );
  }

  // Se consolidado, agrupar por mês somando empresas
  const consolidated = new Map<number, any>();
  for (const row of data) {
    if (!consolidated.has(row.mes)) {
      consolidated.set(row.mes, { ...row });
    } else {
      const c = consolidated.get(row.mes)!;
      const numFields = [
        'receita_bruta', 'deducoes', 'receita_liquida', 'cmv', 'lucro_bruto',
        'despesas_operacionais', 'despesas_administrativas', 'despesas_comerciais',
        'despesas_financeiras', 'receitas_financeiras', 'resultado_operacional',
        'outras_receitas', 'outras_despesas', 'resultado_antes_impostos',
        'impostos', 'resultado_liquido'
      ];
      for (const f of numFields) {
        c[f] = (c[f] || 0) + (row[f] || 0);
      }
    }
  }
  const rows = Array.from(consolidated.values()).sort((a: any, b: any) => a.mes - b.mes);

  const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

  const dreLines = [
    { label: 'Receita Bruta', field: 'receita_bruta', bold: true, color: '' },
    { label: '(-) Deduções', field: 'deducoes', bold: false, color: 'text-red-500' },
    { label: '= Receita Líquida', field: 'receita_liquida', bold: true, color: '' },
    { label: '(-) CMV', field: 'cmv', bold: false, color: 'text-red-500' },
    { label: '= Lucro Bruto', field: 'lucro_bruto', bold: true, color: 'text-emerald-600' },
    { label: '(-) Desp. Operacionais', field: 'despesas_operacionais', bold: false, color: 'text-red-500' },
    { label: '(-) Desp. Administrativas', field: 'despesas_administrativas', bold: false, color: 'text-red-500' },
    { label: '(-) Desp. Comerciais', field: 'despesas_comerciais', bold: false, color: 'text-red-500' },
    { label: '(-) Desp. Financeiras', field: 'despesas_financeiras', bold: false, color: 'text-red-500' },
    { label: '(+) Rec. Financeiras', field: 'receitas_financeiras', bold: false, color: 'text-emerald-500' },
    { label: '= Resultado Operacional', field: 'resultado_operacional', bold: true, color: '' },
    { label: '(-) Impostos', field: 'impostos', bold: false, color: 'text-red-500' },
    { label: '= RESULTADO LÍQUIDO', field: 'resultado_liquido', bold: true, color: '' },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          DRE Gerencial — {ano}
          {view === 'all' && <Badge variant="secondary" className="ml-2">Consolidado</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-background min-w-[180px]">Linha</TableHead>
                {rows.map((r: any) => (
                  <TableHead key={r.mes} className="text-right min-w-[100px]">
                    {meses[r.mes - 1]}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {dreLines.map(line => (
                <TableRow key={line.field} className={line.bold ? 'bg-muted/30' : ''}>
                  <TableCell className={`sticky left-0 bg-background text-sm ${line.bold ? 'font-bold' : ''}`}>
                    {line.label}
                  </TableCell>
                  {rows.map((r: any) => {
                    const val = r[line.field] || 0;
                    const colorClass = line.color || (line.bold && line.field.includes('resultado')
                      ? (val >= 0 ? 'text-emerald-600' : 'text-red-600')
                      : '');
                    return (
                      <TableCell key={r.mes} className={`text-right text-sm ${line.bold ? 'font-bold' : ''} ${colorClass}`}>
                        {fmtCompact(val)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              {/* Margem bruta % */}
              <TableRow className="border-t-2">
                <TableCell className="sticky left-0 bg-background text-sm font-medium text-muted-foreground">
                  Margem Bruta %
                </TableCell>
                {rows.map((r: any) => {
                  const pct = r.receita_liquida > 0 ? (r.lucro_bruto / r.receita_liquida) * 100 : 0;
                  return (
                    <TableCell key={r.mes} className="text-right text-sm text-muted-foreground">
                      {pct.toFixed(1)}%
                    </TableCell>
                  );
                })}
              </TableRow>
              {/* Margem líquida % */}
              <TableRow>
                <TableCell className="sticky left-0 bg-background text-sm font-medium text-muted-foreground">
                  Margem Líquida %
                </TableCell>
                {rows.map((r: any) => {
                  const pct = r.receita_liquida > 0 ? (r.resultado_liquido / r.receita_liquida) * 100 : 0;
                  return (
                    <TableCell key={r.mes} className={`text-right text-sm font-medium ${pct >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {pct.toFixed(1)}%
                    </TableCell>
                  );
                })}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ═══════════════ HELPERS ═══════════════

function DREComparativo({ data, ano }: { data: Record<string, any[]>; ano: number }) {
  const companies = Object.keys(data);
  if (companies.length < 2) return null;

  const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

  // Calculate annual totals per company
  const annualTotals = companies.map(co => {
    const rows = data[co] || [];
    const total = rows.reduce(
      (acc, r) => ({
        receita_liquida: acc.receita_liquida + (r.receita_liquida || 0),
        lucro_bruto: acc.lucro_bruto + (r.lucro_bruto || 0),
        resultado_operacional: acc.resultado_operacional + (r.resultado_operacional || 0),
        resultado_liquido: acc.resultado_liquido + (r.resultado_liquido || 0),
        impostos: acc.impostos + (r.impostos || 0),
      }),
      { receita_liquida: 0, lucro_bruto: 0, resultado_operacional: 0, resultado_liquido: 0, impostos: 0 }
    );
    const margemBruta = total.receita_liquida > 0 ? (total.lucro_bruto / total.receita_liquida) * 100 : 0;
    const margemLiquida = total.receita_liquida > 0 ? (total.resultado_liquido / total.receita_liquida) * 100 : 0;
    return { company: co, ...total, margemBruta, margemLiquida };
  });

  const lines: { label: string; field: string; format: 'currency' | 'pct' }[] = [
    { label: 'Receita Líquida', field: 'receita_liquida', format: 'currency' },
    { label: 'Lucro Bruto', field: 'lucro_bruto', format: 'currency' },
    { label: 'Margem Bruta', field: 'margemBruta', format: 'pct' },
    { label: 'Resultado Operacional', field: 'resultado_operacional', format: 'currency' },
    { label: 'Impostos', field: 'impostos', format: 'currency' },
    { label: 'Resultado Líquido', field: 'resultado_liquido', format: 'currency' },
    { label: 'Margem Líquida', field: 'margemLiquida', format: 'pct' },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <PieChart className="w-4 h-4" />
          Comparativo por Empresa — {ano}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-background min-w-[180px]">Indicador</TableHead>
                {annualTotals.map(t => (
                  <TableHead key={t.company} className="text-right min-w-[120px]">
                    <div className="flex flex-col items-end">
                      <span>{COMPANIES[t.company as Company]?.shortName || t.company}</span>
                      <Badge variant="outline" className="text-[10px] mt-0.5">
                        {COMPANIES[t.company as Company]?.regime === 'simples' ? 'SN' : 'LP'}
                      </Badge>
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map(line => (
                <TableRow key={line.field}>
                  <TableCell className="sticky left-0 bg-background text-sm font-medium">
                    {line.label}
                  </TableCell>
                  {annualTotals.map(t => {
                    const val = (t as any)[line.field] || 0;
                    const isResult = line.field.includes('resultado') || line.field === 'margemLiquida';
                    const colorClass = isResult
                      ? val >= 0 ? 'text-emerald-600' : 'text-red-600'
                      : '';
                    return (
                      <TableCell key={t.company} className={`text-right text-sm font-medium ${colorClass}`}>
                        {line.format === 'pct' ? `${val.toFixed(1)}%` : fmtCompact(val)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              {/* Participação na receita total */}
              <TableRow className="border-t-2">
                <TableCell className="sticky left-0 bg-background text-sm font-medium text-muted-foreground">
                  % da Receita Total
                </TableCell>
                {(() => {
                  const totalReceita = annualTotals.reduce((s, t) => s + t.receita_liquida, 0);
                  return annualTotals.map(t => (
                    <TableCell key={t.company} className="text-right text-sm text-muted-foreground">
                      {totalReceita > 0 ? `${((t.receita_liquida / totalReceita) * 100).toFixed(1)}%` : '—'}
                    </TableCell>
                  ));
                })()}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function getWeekLabel(d: Date): string {
  const start = new Date(d);
  start.setDate(start.getDate() - start.getDay());
  return `${String(start.getDate()).padStart(2, '0')}/${String(start.getMonth() + 1).padStart(2, '0')}`;
}

function formatCnpj(cnpj: string): string {
  if (cnpj.length === 14) {
    return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  if (cnpj.length === 11) {
    return cnpj.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  }
  return cnpj;
}

export default FinanceiroDashboard;
