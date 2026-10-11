import type { FinResumo, AgingData } from '@/services/financeiroService';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import { AlertTriangle, TrendingDown, Clock, ShieldAlert, type LucideIcon } from 'lucide-react';

export interface FinAlert {
  severity: 'critical' | 'warning' | 'info';
  company: string;
  message: string;
  metric?: string;
  icon: LucideIcon;
}

export function generateAlerts(
  resumo: Record<string, FinResumo>,
  agingReceber?: AgingData | null,
  _agingPagar?: AgingData | null,
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

    // Cobertura de caixa baixa (<30% do CP). Sem saldo conhecido NÃO se alerta: com o zero
    // fabricado de antes, saldo indisponível virava cobertura de 0% e disparava alerta
    // CRÍTICO de liquidez sobre uma empresa que pode estar com o caixa cheio. Precisão >
    // recall — o "—" do KPI de saldo é quem conta ao dono que o dado faltou.
    if (r.saldo_total_cc !== null && r.total_a_pagar > 0 && r.saldo_total_cc / r.total_a_pagar < 0.30) {
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

/**
 * Alertas da tela, escopados às empresas da `view`. O mapa `resumo` do hook acumula empresas de
 * cargas anteriores (outras views): passá-lo inteiro punha alerta da Colacor sob o rótulo da
 * Oben quando o resumo da Oben falhava. Resumo da view incompleto (algum CNPJ sem leitura) →
 * nenhum alerta de resumo: ausente não é "sem alerta", e o motivo já aparece no aviso de
 * indisponível da Visão Geral. O aging já é carregado por view, então continua valendo.
 */
export function alertasDaView(
  resumo: Record<string, FinResumo>,
  view: 'all' | Company,
  agingReceber?: AgingData | null,
  agingPagar?: AgingData | null,
): FinAlert[] {
  const empresas: Company[] = view === 'all' ? ALL_COMPANIES : [view];
  const completo = empresas.every((co) => resumo[co] !== undefined);
  const daView: Record<string, FinResumo> = completo
    ? Object.fromEntries(empresas.map((co) => [co, resumo[co]]))
    : {};
  return generateAlerts(daView, agingReceber, agingPagar);
}
