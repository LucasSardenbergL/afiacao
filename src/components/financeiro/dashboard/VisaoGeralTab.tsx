// Conteúdo da aba "Visão Geral" do dashboard financeiro.
// Extraído de src/pages/FinanceiroDashboard.tsx (god-component split).
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  TrendingUp, TrendingDown, AlertTriangle, Wallet,
  ArrowDownCircle, ArrowUpCircle, BarChart3,
} from 'lucide-react';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import { type FinanceiroView } from '@/hooks/useFinanceiro';
import type { FinResumo, AgingData } from '@/services/financeiroService';
import type { FinAlert } from '@/utils/financeiroAlerts';
import { fmt, fmtCompact, formatCnpj } from '@/components/financeiro/dashboard/format';
import { KpiCard } from '@/components/financeiro/dashboard/KpiCard';
import { AgingCard } from '@/components/financeiro/dashboard/AgingCard';
import { DataHealthBanner } from '@/components/dataHealth/DataHealthBanner';

export function VisaoGeralTab({
  alerts, activeResumo, resumo, view, agingReceber, agingPagar, inadimplentes,
}: {
  alerts: FinAlert[];
  activeResumo: FinResumo | null;
  resumo: Record<string, FinResumo>;
  view: FinanceiroView;
  agingReceber: AgingData | null;
  agingPagar: AgingData | null;
  inadimplentes: { nome: string; cnpj: string; total_vencido: number; qtd_titulos: number }[];
}) {
  const [showContasZeradas, setShowContasZeradas] = useState(false);
  // Esconde contas com saldo zerado por padrão (ruído numa lista de ~40 contas).
  // Se TODAS estiverem zeradas, mostra mesmo assim (senão o card ficaria vazio).
  const contasCorrentes = activeResumo?.contas_correntes ?? [];
  const contasComSaldo = contasCorrentes.filter((cc) => cc.saldo_atual !== 0);
  const qtdZeradas = contasCorrentes.length - contasComSaldo.length;
  const contasVisiveis =
    showContasZeradas || contasComSaldo.length === 0 ? contasCorrentes : contasComSaldo;

  return (
    <>
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
        <AgingCard title="Aging Pagáveis" data={agingPagar} type="pagar" />
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
                <p className={`text-lg kpi-value mt-1 ${
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
                <p className={`text-lg kpi-value mt-1 ${
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
                <p className={`text-lg kpi-value mt-1 ${
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
                <p className={`text-lg kpi-value mt-1 ${
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
      <DataHealthBanner source="saldo_bancario" />
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
              {contasVisiveis.map((cc, idx) => (
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
            {qtdZeradas > 0 && contasComSaldo.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 h-auto px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowContasZeradas((v) => !v)}
              >
                {showContasZeradas
                  ? 'Ocultar contas zeradas'
                  : `Mostrar ${qtdZeradas} ${qtdZeradas === 1 ? 'conta zerada' : 'contas zeradas'}`}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
