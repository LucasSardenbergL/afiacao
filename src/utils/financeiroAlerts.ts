import type { FinResumo, AgingData } from '@/services/financeiroService';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import { AlertTriangle, TrendingDown, Clock, ShieldAlert } from 'lucide-react';

export interface FinAlert {
  severity: 'critical' | 'warning' | 'info';
  company: string;
  message: string;
  metric?: string;
  icon: any;
}

export function generateAlerts(
  resumo: Record<string, FinResumo>,
  agingReceber?: AgingData | null,
  agingPagar?: AgingData | null,
): FinAlert[] {
  const alerts: FinAlert[] = [];

  for (const [co, r] of Object.entries(resumo)) {
    const name = COMPANIES[co as Company]?.shortName || co;

    // Posição líquida negativa
    if (r.posicao_liquida < 0) {
      alerts.push({
        severity: Math.abs(r.posicao_liquida) > 50000 ? 'critical' : 'warning',
        company: co,
        message: `${name}: posição líquida negativa`,
        metric: `CP supera CR em R$ ${Math.abs(r.posicao_liquida).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`,
        icon: TrendingDown,
      });
    }

    // Inadimplência alta (>20% do total a receber)
    if (r.total_a_receber > 0 && r.total_vencido_receber / r.total_a_receber > 0.20) {
      const pct = ((r.total_vencido_receber / r.total_a_receber) * 100).toFixed(0);
      alerts.push({
        severity: Number(pct) > 35 ? 'critical' : 'warning',
        company: co,
        message: `${name}: inadimplência de ${pct}%`,
        metric: `R$ ${r.total_vencido_receber.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} vencido`,
        icon: AlertTriangle,
      });
    }

    // Cobertura de caixa baixa (<30% do CP)
    if (r.total_a_pagar > 0 && r.saldo_total_cc / r.total_a_pagar < 0.30) {
      const pct = ((r.saldo_total_cc / r.total_a_pagar) * 100).toFixed(0);
      alerts.push({
        severity: Number(pct) < 15 ? 'critical' : 'warning',
        company: co,
        message: `${name}: cobertura de caixa de ${pct}%`,
        metric: `Saldo CC cobre apenas ${pct}% do CP total`,
        icon: ShieldAlert,
      });
    }

    // Vencidos a pagar
    if (r.total_vencido_pagar > 10000) {
      alerts.push({
        severity: r.total_vencido_pagar > 50000 ? 'critical' : 'warning',
        company: co,
        message: `${name}: R$ ${r.total_vencido_pagar.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} em CP vencidos`,
        icon: Clock,
      });
    }
  }

  // Aging >90 dias (consolidado)
  if (agingReceber && agingReceber.vencido_90_plus_valor > 20000) {
    alerts.push({
      severity: 'critical',
      company: 'all',
      message: `R$ ${agingReceber.vencido_90_plus_valor.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} em recebíveis com +90 dias`,
      metric: `${agingReceber.vencido_90_plus_qtd} título(s) — risco alto de perda`,
      icon: AlertTriangle,
    });
  }

  // Sort by severity
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
}
