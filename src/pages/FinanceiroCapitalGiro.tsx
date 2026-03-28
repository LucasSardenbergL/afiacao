import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import { getCapitalDeGiro, type CapitalDeGiro } from '@/services/financeiroService';
import {
  Loader2, Building2, TrendingUp, TrendingDown, Clock,
  AlertTriangle, Wallet, ArrowDownCircle, ArrowUpCircle,
  BarChart3, Target, ShieldCheck
} from 'lucide-react';

const fmt = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtCompact = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${(v / 1_000).toFixed(1)}k`;
  return fmt(v);
};

const FinanceiroCapitalGiro = () => {
  const [data, setData] = useState<CapitalDeGiro[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'all' | Company>('all');

  useEffect(() => {
    loadData();
  }, [view]);

  const loadData = async () => {
    setLoading(true);
    try {
      const result = await getCapitalDeGiro(view);
      setData(result);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // Consolidado — médias ponderadas por volume (Ponto 10)
  const consolidated: CapitalDeGiro | null = data.length > 0
    ? (() => {
        const totalCR = data.reduce((s, d) => s + d.total_cr_aberto, 0);
        const totalCP = data.reduce((s, d) => s + d.total_cp_aberto, 0);

        // PMR ponderado pelo volume de CR de cada empresa
        const pmrWeighted = totalCR > 0
          ? Math.round(data.reduce((s, d) => s + d.pmr * d.total_cr_aberto, 0) / totalCR)
          : 0;
        // PMP ponderado pelo volume de CP de cada empresa
        const pmpWeighted = totalCP > 0
          ? Math.round(data.reduce((s, d) => s + d.pmp * d.total_cp_aberto, 0) / totalCP)
          : 0;

        return {
          company: 'consolidado',
          total_cr_aberto: totalCR,
          total_cp_aberto: totalCP,
          saldo_cc: data.reduce((s, d) => s + d.saldo_cc, 0),
          capital_giro: data.reduce((s, d) => s + d.capital_giro, 0),
          capital_giro_liquido: data.reduce((s, d) => s + d.capital_giro_liquido, 0),
          pmr: pmrWeighted,
          pmp: pmpWeighted,
          ciclo_financeiro: pmrWeighted - pmpWeighted,
          top5_cr_pct: 0, // Não faz sentido consolidar % de concentração
          top5_cp_pct: 0,
          entradas_30d: data.reduce((s, d) => s + d.entradas_30d, 0),
          saidas_30d: data.reduce((s, d) => s + d.saidas_30d, 0),
          saldo_projetado_30d: data.reduce((s, d) => s + d.saldo_projetado_30d, 0),
        };
      })()
    : null;

  const active = view === 'all' ? consolidated : data[0] || null;

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
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Capital de Giro</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Análise de liquidez, ciclo financeiro e projeções
          </p>
        </div>
        <Select value={view} onValueChange={v => setView(v as any)}>
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
              <p className={`text-2xl font-bold mt-1 ${active.ciclo_financeiro > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                {active.ciclo_financeiro} dias
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                PMR {active.pmr}d − PMP {active.pmp}d
              </p>
            </div>
          </div>

          {/* Ciclo Financeiro Visual */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="w-4 h-4" />
                Ciclo Financeiro
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                {/* PMR Bar */}
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-muted-foreground">Prazo Médio de Recebimento</span>
                    <span className="font-bold">{active.pmr} dias</span>
                  </div>
                  <div className="h-4 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-all"
                      style={{ width: `${Math.min((active.pmr / Math.max(active.pmr, active.pmp, 1)) * 100, 100)}%` }}
                    />
                  </div>
                </div>
                {/* PMP Bar */}
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-muted-foreground">Prazo Médio de Pagamento</span>
                    <span className="font-bold">{active.pmp} dias</span>
                  </div>
                  <div className="h-4 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-all"
                      style={{ width: `${Math.min((active.pmp / Math.max(active.pmr, active.pmp, 1)) * 100, 100)}%` }}
                    />
                  </div>
                </div>
              </div>

              <div className={`p-4 rounded-lg ${active.ciclo_financeiro > 0 ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'} border`}>
                <p className={`text-sm font-medium ${active.ciclo_financeiro > 0 ? 'text-amber-800' : 'text-emerald-800'}`}>
                  {active.ciclo_financeiro > 0
                    ? `Ciclo positivo de ${active.ciclo_financeiro} dias — você financia seus clientes por ${active.ciclo_financeiro} dias antes de receber.`
                    : active.ciclo_financeiro < 0
                      ? `Ciclo negativo de ${Math.abs(active.ciclo_financeiro)} dias — você recebe antes de pagar, gerando caixa livre.`
                      : 'Ciclo neutro — recebimento e pagamento estão alinhados.'
                  }
                </p>
                {active.ciclo_financeiro > 15 && (
                  <p className="text-xs mt-2 text-amber-700">
                    Considere: renegociar prazos com fornecedores, antecipar recebíveis, ou reduzir prazos de vendas.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Projeção 30 dias */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Target className="w-4 h-4" />
                Projeção de Caixa — Próximos 30 dias
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div className="p-3 rounded-lg bg-blue-50">
                    <p className="text-xs text-muted-foreground">Saldo Atual CC</p>
                    <p className="text-lg font-bold text-blue-600">{fmtCompact(active.saldo_cc)}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/50">
                    <p className="text-xs text-muted-foreground">Fluxo Líquido 30d</p>
                    <p className={`text-lg font-bold ${active.entradas_30d - active.saidas_30d >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {fmtCompact(active.entradas_30d - active.saidas_30d)}
                    </p>
                  </div>
                  <div className={`p-3 rounded-lg ${active.saldo_projetado_30d >= 0 ? 'bg-emerald-50' : 'bg-red-50'}`}>
                    <p className="text-xs text-muted-foreground">Saldo Projetado</p>
                    <p className={`text-lg font-bold ${active.saldo_projetado_30d >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {fmtCompact(active.saldo_projetado_30d)}
                    </p>
                  </div>
                </div>

                {/* Waterfall visual */}
                <div className="flex items-end justify-center gap-2 h-32">
                  <WaterfallBar label="CC Atual" value={active.saldo_cc} max={Math.max(active.saldo_cc, active.saldo_projetado_30d, active.entradas_30d)} color="bg-blue-500" />
                  <WaterfallBar label="Entradas" value={active.entradas_30d} max={Math.max(active.saldo_cc, active.saldo_projetado_30d, active.entradas_30d)} color="bg-emerald-500" />
                  <WaterfallBar label="Saídas" value={active.saidas_30d} max={Math.max(active.saldo_cc, active.saldo_projetado_30d, active.entradas_30d)} color="bg-red-500" />
                  <WaterfallBar label="Projetado" value={active.saldo_projetado_30d} max={Math.max(active.saldo_cc, active.saldo_projetado_30d, active.entradas_30d)} color={active.saldo_projetado_30d >= 0 ? 'bg-emerald-600' : 'bg-red-600'} />
                </div>

                {active.saldo_projetado_30d < 0 && (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200">
                    <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-red-800">Projeção negativa</p>
                      <p className="text-xs text-red-700 mt-1">
                        Déficit projetado de {fmtCompact(Math.abs(active.saldo_projetado_30d))} nos próximos 30 dias.
                        Ação necessária: antecipar recebíveis, renegociar prazos de CP, ou injetar capital.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Comparativo por empresa */}
          {view === 'all' && data.length > 1 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="w-4 h-4" />
                  Comparativo por Empresa
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="sticky left-0 bg-background">Indicador</TableHead>
                        {data.map(d => (
                          <TableHead key={d.company} className="text-right min-w-[120px]">
                            <div className="flex flex-col items-end">
                              <span>{COMPANIES[d.company as Company]?.shortName}</span>
                              <Badge variant="outline" className="text-[10px] mt-0.5">
                                {COMPANIES[d.company as Company]?.regime === 'simples' ? 'SN' : 'LP'}
                              </Badge>
                            </div>
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[
                        { label: 'CR Aberto', field: 'total_cr_aberto', fmt: 'currency' },
                        { label: 'CP Aberto', field: 'total_cp_aberto', fmt: 'currency' },
                        { label: 'Saldo CC', field: 'saldo_cc', fmt: 'currency' },
                        { label: 'Capital de Giro', field: 'capital_giro', fmt: 'currency' },
                        { label: 'CG Líquido', field: 'capital_giro_liquido', fmt: 'currency' },
                        { label: 'PMR', field: 'pmr', fmt: 'days' },
                        { label: 'PMP', field: 'pmp', fmt: 'days' },
                        { label: 'Ciclo Financeiro', field: 'ciclo_financeiro', fmt: 'days' },
                        { label: 'Concentração CR (Top 5)', field: 'top5_cr_pct', fmt: 'pct' },
                        { label: 'Concentração CP (Top 5)', field: 'top5_cp_pct', fmt: 'pct' },
                        { label: 'Projeção 30d', field: 'saldo_projetado_30d', fmt: 'currency' },
                      ].map(line => (
                        <TableRow key={line.field}>
                          <TableCell className="sticky left-0 bg-background text-sm font-medium">
                            {line.label}
                          </TableCell>
                          {data.map(d => {
                            const val = (d as any)[line.field] || 0;
                            const isResult = ['capital_giro', 'capital_giro_liquido', 'saldo_projetado_30d'].includes(line.field);
                            const color = isResult ? (val >= 0 ? 'text-emerald-600' : 'text-red-600') : '';
                            let display = '';
                            if (line.fmt === 'currency') display = fmtCompact(val);
                            else if (line.fmt === 'days') display = `${val}d`;
                            else if (line.fmt === 'pct') display = `${val.toFixed(0)}%`;
                            return (
                              <TableCell key={d.company} className={`text-right text-sm font-medium ${color}`}>
                                {display}
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Concentração de risco */}
          {active.top5_cr_pct > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4" />
                  Concentração de Risco
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <p className="text-sm text-muted-foreground mb-2">Recebíveis — Top 5 clientes</p>
                    <div className="flex items-center gap-3">
                      <Progress
                        value={active.top5_cr_pct}
                        className={`h-3 ${active.top5_cr_pct > 70 ? '[&>div]:bg-red-500' : active.top5_cr_pct > 50 ? '[&>div]:bg-amber-500' : '[&>div]:bg-emerald-500'}`}
                      />
                      <span className="text-sm font-bold">{active.top5_cr_pct.toFixed(0)}%</span>
                    </div>
                    {active.top5_cr_pct > 60 && (
                      <p className="text-xs text-amber-600 mt-1">Alta concentração — diversifique a base de clientes</p>
                    )}
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground mb-2">Payables — Top 5 fornecedores</p>
                    <div className="flex items-center gap-3">
                      <Progress
                        value={active.top5_cp_pct}
                        className={`h-3 ${active.top5_cp_pct > 70 ? '[&>div]:bg-amber-500' : '[&>div]:bg-blue-500'}`}
                      />
                      <span className="text-sm font-bold">{active.top5_cp_pct.toFixed(0)}%</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
};

// ═══════════════ SUB-COMPONENTS ═══════════════

function MetricCard({ title, value, subtitle, positive, icon: Icon }: {
  title: string; value: number; subtitle: string; positive: boolean; icon: any;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground font-medium">{title}</p>
            <p className={`text-lg font-bold mt-1 ${positive ? 'text-emerald-600' : 'text-red-600'}`}>
              {fmtCompact(value)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
          </div>
          <div className={`p-2 rounded-lg ${positive ? 'bg-emerald-50' : 'bg-red-50'}`}>
            <Icon className={`w-4 h-4 ${positive ? 'text-emerald-600' : 'text-red-600'}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function WaterfallBar({ label, value, max, color }: {
  label: string; value: number; max: number; color: string;
}) {
  const pct = max > 0 ? Math.min((Math.abs(value) / max) * 100, 100) : 0;
  return (
    <div className="flex flex-col items-center gap-1 flex-1">
      <div className="w-full flex items-end justify-center h-24">
        <div
          className={`w-full max-w-[48px] rounded-t ${color} transition-all`}
          style={{ height: `${Math.max(pct, 5)}%` }}
        />
      </div>
      <span className="text-[10px] text-muted-foreground text-center">{label}</span>
      <span className="text-xs font-bold">{fmtCompact(value)}</span>
    </div>
  );
}

export default FinanceiroCapitalGiro;
