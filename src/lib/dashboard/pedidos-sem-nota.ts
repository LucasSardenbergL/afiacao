/**
 * Pedidos de venda que seguem SEM NOTA no Omie há mais de 30 dias. Puro e testável.
 *
 * Eles estão no universo de venda (positivação, ranking, crescimento contam com eles), mas não viraram
 * receita contábil: medido em 2026-10-12, ~27% da venda do último ano da Oben e, depois da reconciliação
 * da Colacor, o que ela de fato deixa aberto. O faturado da Oben bate com o DRE — o resto é pedido aberto
 * no Omie. Decisão do founder: MOSTRAR, sem mudar a régua de receita.
 * Diário: docs/historico/status-pedidos-colacor-congelado.md.
 */
import { addDias } from './sp-date';
import type { Janela } from './crescimento-comparavel';

/**
 * Status do Omie anteriores à nota (etapas 10/20/50; `importado` também é o default de etapa
 * desconhecida). Fora: `faturado`, `cancelado` e os status avançados no app (confirmado, entregue…),
 * cujo dono não é o Omie.
 */
export const STATUS_SEM_NOTA: readonly string[] = ['importado', 'separacao', 'enviado'];

/** [hoje − 365, hoje − 30): o último ano, sem os 30 dias recentes (pedido recente sem nota é fila). Puro. */
export function janelaSemNotaAntiga(hoje: string): Janela {
  return { de: addDias(hoje, -365), ate: addDias(hoje, -30) };
}

export interface ResumoSemNota {
  receita: number;
  pedidos: number;
  porEmpresa: { account: string; receita: number; pedidos: number }[];
}

export function resumirSemNota(pedidos: { account: string; total: number | null }[]): ResumoSemNota {
  const m = new Map<string, { receita: number; pedidos: number }>();
  for (const p of pedidos) {
    const e = m.get(p.account) ?? { receita: 0, pedidos: 0 };
    e.receita += p.total ?? 0;
    e.pedidos += 1;
    m.set(p.account, e);
  }
  const porEmpresa = [...m.entries()]
    .map(([account, e]) => ({ account, ...e }))
    .sort((a, b) => b.receita - a.receita);
  return {
    receita: porEmpresa.reduce((s, e) => s + e.receita, 0),
    pedidos: pedidos.length,
    porEmpresa,
  };
}

/** Faixas de idade do pedido sem nota: só a mais nova (30–90d) ainda parece venda a faturar. */
export type FaixaSemNota = '30-90' | '90-180' | '180+';

export interface PedidoSemNotaDetalhe {
  id: string;
  account: string;
  total: number | null;
  order_date_kpi: string | null;
  customer_user_id: string | null;
  vendedor_user_id: string | null;
  omie_numero_pedido: string | null;
}

/** Idade em dias entre `order_date_kpi` e `hoje` (YYYY-MM-DD, UTC puro). Puro. */
function idadeDias(dataISO: string, hoje: string): number {
  return Math.round((Date.parse(`${hoje}T00:00:00Z`) - Date.parse(`${dataISO}T00:00:00Z`)) / 86_400_000);
}

/** Faixa do pedido; `null` sem data (não é encaixado em faixa nenhuma — some do recorte, não vira "velho"). */
export function faixaSemNota(dataISO: string | null, hoje: string): FaixaSemNota | null {
  if (!dataISO) return null;
  const d = idadeDias(dataISO, hoje);
  if (d < 90) return '30-90';
  if (d < 180) return '90-180';
  return '180+';
}

export interface ResumoFaixa {
  faixa: FaixaSemNota;
  receita: number;
  pedidos: number;
}

/** Receita e contagem por faixa de idade, sempre nas 3 faixas (zero MEDIDO, não ausente). Puro. */
export function resumirPorFaixa(pedidos: PedidoSemNotaDetalhe[], hoje: string): ResumoFaixa[] {
  const faixas: ResumoFaixa[] = [
    { faixa: '30-90', receita: 0, pedidos: 0 },
    { faixa: '90-180', receita: 0, pedidos: 0 },
    { faixa: '180+', receita: 0, pedidos: 0 },
  ];
  for (const p of pedidos) {
    const f = faixaSemNota(p.order_date_kpi, hoje);
    const alvo = faixas.find((x) => x.faixa === f);
    if (!alvo) continue;
    alvo.receita += p.total ?? 0;
    alvo.pedidos += 1;
  }
  return faixas;
}

export interface ClienteSemNotaRecente {
  customerUserId: string;
  account: string;
  receita: number;
  /** Pedidos do cliente na faixa 30–90d, do mais antigo ao mais novo. */
  pedidos: { id: string; numero: string | null; data: string; total: number | null; vendedorUserId: string | null }[];
}

/**
 * Clientes com pedido sem nota na faixa 30–90d (a que ainda pode faturar), por receita desc. É a lista
 * em que o CEO decide "fatura ou cancela" — o banner sozinho não dizia QUEM. Puro.
 */
export function clientesSemNotaRecentes(pedidos: PedidoSemNotaDetalhe[], hoje: string): ClienteSemNotaRecente[] {
  const m = new Map<string, ClienteSemNotaRecente>();
  for (const p of pedidos) {
    if (faixaSemNota(p.order_date_kpi, hoje) !== '30-90' || !p.customer_user_id || !p.order_date_kpi) continue;
    const chave = `${p.account}:${p.customer_user_id}`;
    const c = m.get(chave) ?? { customerUserId: p.customer_user_id, account: p.account, receita: 0, pedidos: [] };
    c.receita += p.total ?? 0;
    c.pedidos.push({
      id: p.id,
      numero: p.omie_numero_pedido,
      data: p.order_date_kpi,
      total: p.total,
      vendedorUserId: p.vendedor_user_id,
    });
    m.set(chave, c);
  }
  const lista = [...m.values()];
  for (const c of lista) c.pedidos.sort((a, b) => a.data.localeCompare(b.data));
  return lista.sort((a, b) => b.receita - a.receita);
}
