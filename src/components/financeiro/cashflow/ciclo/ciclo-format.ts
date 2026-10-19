// Formatação da aba Ciclo. Ausente ≠ zero: null/undefined sempre vira "—", nunca "R$ 0".
import type { CoorteMes } from '@/hooks/useFinanceiroCiclo';
import type { Company } from '@/contexts/CompanyContext';
import { confiancaCliente, type ResumoCliente } from '@/lib/financeiro/ciclo-cliente-helpers';
import type { ResumoFornecedor } from '@/lib/financeiro/ciclo-fornecedor-helpers';
import { decodeHtmlEntities } from '@/lib/format';

export const brl = (v: number | null | undefined, frac = 0): string =>
  v === null || v === undefined ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: frac });

export const dias = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${v.toFixed(0)}d`);

export type PontoTendencia = { mes: string; concedido: number | null; real: number | null; pago: number | null; parcial: boolean };

export function montarSerieTendencia(coorte: CoorteMes[], company: Company): PontoTendencia[] {
  return coorte.filter((m) => m.company === company).map((m) => ({
    mes: m.mes.slice(0, 7) + (m.mesParcial ? '*' : ''),
    concedido: m.prazoConcedido,
    real: m.prazoReal,
    pago: m.pctValorPago === null ? null : Math.round(m.pctValorPago * 100),
    parcial: m.mesParcial,
  }));
}


export const ROTULO_PERFIL: Record<string, string> = {
  folga: 'Folga', pontual: 'Pontual', atraso_leve: 'Atraso leve', atraso_cronico: 'Atraso crônico', misto: 'Misto', sem_dado: 'Sem pagamento',
};

/** Cobertura por valor: Σ valorPago dos clientes de confiança média / Σ valorPago, POR empresa. Denominador 0/ausente → null + motivo. */
export function coberturaPorValor(resumo: ResumoCliente[], company: Company, hoje: string):
  | { ok: true; pct: number }
  | { ok: false; motivo: string } {
  let den = 0;
  let num = 0;
  for (const c of resumo) {
    if (c.company !== company || c.valorPago === null) continue;
    den += c.valorPago;
    if (confiancaCliente(c, hoje) === 'media') num += c.valorPago;
  }
  return den > 0 ? { ok: true, pct: (num / den) * 100 } : { ok: false, motivo: 'sem valor pago em 12 meses' };
}

/** Chave de URL do custo do dinheiro, uma por empresa (nunca um c único para todas). */
export const CHAVE_CUSTO: Record<Company, 'cicloCustoOben' | 'cicloCustoColacor' | 'cicloCustoColacorSc'> = {
  oben: 'cicloCustoOben', colacor: 'cicloCustoColacor', colacor_sc: 'cicloCustoColacorSc',
};

/** Nome do cliente para a tela: o cadastro do Omie traz entidade HTML ("MOVEIS &amp; CIA");
 *  sem nome em nenhuma fonte, mostra o código (nunca um nome inventado). */
export function nomeExibido(c: Pick<ResumoCliente, 'nomeCliente' | 'omieCodigoCliente'>): string {
  return c.nomeCliente ? decodeHtmlEntities(c.nomeCliente) : `#${c.omieCodigoCliente}`;
}

/** Fornecedor sem nome em nenhuma fonte aparece pelo código do Omie (nunca um nome inventado). */
export function nomeFornecedor(f: Pick<ResumoFornecedor, 'nome' | 'fornecedor'>): string {
  return f.nome ? decodeHtmlEntities(f.nome) : `#${f.fornecedor}`;
}
