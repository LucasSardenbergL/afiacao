// Consolidação de capital de giro — médias ponderadas por volume.
// Extraída verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split).
import type { CapitalDeGiro } from '@/services/financeiroService';

// Consolidado — médias ponderadas por volume (Ponto 10)
export function buildConsolidated(data: CapitalDeGiro[]): CapitalDeGiro | null {
  if (data.length === 0) return null;

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
}
