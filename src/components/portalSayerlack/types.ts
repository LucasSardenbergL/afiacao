// Tipos, constantes e helpers puros do Portal Sayerlack (AdminPortalSayerlack).
// Extraídos de src/pages/AdminPortalSayerlack.tsx (god-component split).

export const SAYERLACK_FILTER = {
  empresa: 'OBEN',
  fornecedorIlike: '%SAYERLACK%',
};

export function fmtBRL(v: number | null | undefined) {
  if (v == null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v));
}
export function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-BR');
}
export function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR');
}
export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const past = diff >= 0;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return past ? `há ${min}m` : `em ${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return past ? `há ${h}h` : `em ${h}h`;
  const d = Math.round(h / 24);
  return past ? `há ${d}d` : `em ${d}d`;
}

export type PedidoRow = {
  id: number;
  empresa: string;
  fornecedor_nome: string | null;
  data_ciclo: string | null;
  num_skus: number | null;
  valor_total: number | null;
  status: string | null;
  status_envio_portal: string | null;
  aprovado_em: string | null;
  enviado_portal_em: string | null;
  portal_tentativas: number | null;
  portal_proximo_retry_em: string | null;
  portal_protocolo: string | null;
  portal_screenshot_url: string | null;
  portal_erro: string | null;
};

export const PEDIDO_COLS =
  'id, empresa, fornecedor_nome, data_ciclo, num_skus, valor_total, status, status_envio_portal, aprovado_em, enviado_portal_em, portal_tentativas, portal_proximo_retry_em, portal_protocolo, portal_screenshot_url, portal_erro';

export type PortalKpis = {
  pendentes: number;
  conciliacao: number;
  enviados7d: number;
  taxa: number | null;
};

export type PortalStats = {
  porDia: Array<{ dia: string; enviado: number; falha: number }>;
  bins: Array<{ label: string; min: number; max: number; count: number }>;
  topErros: Array<{ erro: string; count: number; ultimo: string }>;
};
