// Consolidação de capital de giro — médias ponderadas por volume.
// Extraída verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split).
import type { CapitalDeGiro } from '@/services/financeiroService';

// Consolidado — médias ponderadas por volume (Ponto 10)
export function buildConsolidated(data: CapitalDeGiro[]): CapitalDeGiro | null {
  if (data.length === 0) return null;

  const totalCR = data.reduce((s, d) => s + d.total_cr_aberto, 0);
  const totalCP = data.reduce((s, d) => s + d.total_cp_aberto, 0);

  // PMR/PMP ponderados por volume — só entre empresas COM prazo (pmr/pmp não-null) e
  // com volume. null (não 0) quando nenhuma empresa tem prazo, pra não diluir um número
  // real com zeros falsos nem mostrar "0 dias" enganoso. Ver §10 (auditoria 2026-05-27).
  const weighted = (valKey: 'pmr' | 'pmp', wKey: 'total_cr_aberto' | 'total_cp_aberto'): number | null => {
    const elig = data.filter((d) => d[valKey] !== null);
    const w = elig.reduce((s, d) => s + d[wKey], 0);
    return w > 0 ? Math.round(elig.reduce((s, d) => s + (d[valKey] as number) * d[wKey], 0) / w) : null;
  };
  const pmrWeighted = weighted('pmr', 'total_cr_aberto');
  // Saldo CC: UMA empresa indisponível torna o consolidado indisponível — somar só as outras
  // seria um caixa parcial com cara de total (ausente ≠ zero). Os motivos vêm juntos.
  const somaOuNull = (key: 'saldo_cc' | 'capital_giro_liquido' | 'saldo_projetado_30d'): number | null =>
    data.some((d) => d[key] == null) ? null : data.reduce((s, d) => s + (d[key] as number), 0);
  const motivosCC = data.filter((d) => d.saldo_cc_motivo).map((d) => `${d.company}: ${d.saldo_cc_motivo}`);
  const pmpWeighted = weighted('pmp', 'total_cp_aberto');

  return {
    company: 'consolidado',
    total_cr_aberto: totalCR,
    total_cp_aberto: totalCP,
    saldo_cc: somaOuNull('saldo_cc'),
    saldo_cc_motivo: motivosCC.length > 0 ? motivosCC.join(' ') : null,
    capital_giro: data.reduce((s, d) => s + d.capital_giro, 0),
    capital_giro_liquido: somaOuNull('capital_giro_liquido'),
    pmr: pmrWeighted,
    pmp: pmpWeighted,
    ciclo_financeiro: pmrWeighted !== null && pmpWeighted !== null ? pmrWeighted - pmpWeighted : null,
    top5_cr_pct: 0, // Não faz sentido consolidar % de concentração
    top5_cp_pct: 0,
    entradas_30d: data.reduce((s, d) => s + d.entradas_30d, 0),
    saidas_30d: data.reduce((s, d) => s + d.saidas_30d, 0),
    saldo_projetado_30d: somaOuNull('saldo_projetado_30d'),
  };
}
