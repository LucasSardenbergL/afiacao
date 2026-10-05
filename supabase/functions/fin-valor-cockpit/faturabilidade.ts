// Faturabilidade e JANELA do TTM do Cockpit de Valor — a régua que decide quais itens entram na
// receita. Ela roda SÓ nesta edge (o front recebe o TTM pronto), então vive aqui e é testada DIRETO
// pelo vitest (`src/lib/financeiro/__tests__/valor-cockpit-helpers.test.ts`), sem cópia em `src/`
// para manter em paridade — o mesmo arranjo de `_shared/janela-pedidos-compra.ts`. Até o #2766
// eram DUAS cópias: a de `src/` tinha a matriz de testes; a de `index.ts`, a que de fato somava a
// receita, não tinha nenhum (Codex: trocar só lá `deletedAt != null` por `== null` devolvia pedido
// apagado ao TTM com a suíte inteira verde).
import { STATUS_NAO_VENDA } from '../_shared/universo-pedidos.ts';

// Faturabilidade do pedido pai — o universo de VENDA da autoridade (`STATUS_NAO_VENDA` + deleted_at),
// o mesmo do v_caca desde o #2726. A cópia `['cancelado','rascunho']` que morava na edge deixava
// orçamento e pendente contarem no TTM. Blocklist semântica: status conhecido NOVO (ex.: 'entregue')
// CONTA por default — não subconta silenciosamente (Codex 2026-06-18); não-venda, soft-deletado ou
// status NULL não contam. Sem este guard o cockpit somava cancelado como faturamento (um outlier de
// R$615M inflava o TTM da Oben de ~R$5M para ~R$621M).
export function pedidoContaNoFaturamento(status: string | null | undefined, deletedAt: string | null | undefined): boolean {
  if (deletedAt != null) return false;            // soft-deletado nunca conta
  if (status == null) return false;               // espelha o NULL NOT IN da autoridade (NULL não passa o WHERE)
  return !STATUS_NAO_VENDA.includes(status);      // default-inclui status conhecido novo
}

// O pedido pai entra no TTM: faturável E com `order_date_kpi` em [inicio, fim], os DOIS extremos
// inclusive. `order_date_kpi` é DATE → a comparação de string 'YYYY-MM-DD' é cronológica (mesmo
// padrão de carteira-positivacao-snapshot). Sem data KPI o pedido não tem dia — não entra.
export function pedidoEntraNoTTM(
  pedido: { status: string | null; deleted_at: string | null; order_date_kpi: string | null },
  inicio: string,
  fim: string,
): boolean {
  return pedidoContaNoFaturamento(pedido.status, pedido.deleted_at)
    && pedido.order_date_kpi != null && pedido.order_date_kpi >= inicio && pedido.order_date_kpi <= fim;
}
