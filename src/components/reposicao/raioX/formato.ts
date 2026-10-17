// Formatação do Raio-X. Ausente ≠ zero: valor null NUNCA vira "R$ 0,00".
export const SEM_CUSTO = 'sem custo — não avaliado';
export const SEM_NF = 'sem histórico de venda (NF)';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const brl2 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export const fmtValor = (v: number | null): string => (v === null ? SEM_CUSTO : brl.format(v));
export const fmtValorFino = (v: number | null): string => (v === null ? SEM_CUSTO : brl2.format(v));
export const fmtReais = (v: number): string => brl.format(v);
