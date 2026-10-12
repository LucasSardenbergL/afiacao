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
