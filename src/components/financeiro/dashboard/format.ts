// Formatters puros do dashboard financeiro.
// Extraídos de src/pages/FinanceiroDashboard.tsx (god-component split).

export const fmt = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Valor de BAIXA (ou do saldo derivado dela): "—" quando o consumidor marcou `null` porque a
 * FONTE não ingere a baixa — ver `@/lib/financeiro/procedencia-baixa`.
 *
 * ⚠️ O gatilho é o `null` que veio da procedência, NUNCA `v === 0`: zero que chega como número é
 * um fato medido e tem de aparecer como R$ 0,00.
 */
export const fmtBaixa = (v: number | null) => (v === null ? '—' : fmt(v));

export const fmtCompact = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${(v / 1_000).toFixed(1)}k`;
  return fmt(v);
};

export const fmtDate = (d: string | null) => {
  if (!d) return '—';
  const date = new Date(d + 'T00:00:00');
  return date.toLocaleDateString('pt-BR');
};

export const statusColor = (s: string) => {
  switch (s) {
    case 'PAGO': case 'RECEBIDO': case 'LIQUIDADO': return 'bg-status-success-bg text-status-success';
    case 'VENCIDO': return 'bg-status-error-bg text-status-error';
    case 'PARCIAL': return 'bg-status-warning-bg text-status-warning';
    case 'CANCELADO': return 'bg-gray-100 text-gray-500';
    default: return 'bg-status-info-bg text-status-info';
  }
};

export function getWeekLabel(d: Date): string {
  const start = new Date(d);
  start.setDate(start.getDate() - start.getDay());
  return `${String(start.getDate()).padStart(2, '0')}/${String(start.getMonth() + 1).padStart(2, '0')}`;
}

export function formatCnpj(cnpj: string): string {
  if (cnpj.length === 14) {
    return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  if (cnpj.length === 11) {
    return cnpj.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  }
  return cnpj;
}
