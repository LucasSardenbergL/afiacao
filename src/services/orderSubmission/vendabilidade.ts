import type { ProductCartItem } from '@/hooks/unifiedOrder/types';
import type { SubmitClient } from './types';

/**
 * Preflight de vendabilidade (fail-closed) — fronteira money-path do submit.
 *
 * O filtro `ativo=true` no catálogo do wizard/tint é UX (não OFERECER inativo). A
 * GARANTIA de não VENDER inativo é aqui: rascunho restaurado e o cache de 10min do
 * catálogo podem trazer um `Product` que ficou inativo no Omie DEPOIS da seleção;
 * `useCart` aceita qualquer `Product` que chegue. Então revalidamos `ativo` no banco
 * imediatamente antes de criar `sales_orders`/PV (submitOrder) ou orçamento (submitQuote).
 *
 * Precisão > recall: na dúvida (produto sumido do catálogo, erro de query) BLOQUEIA —
 * melhor segurar um pedido que vender um fantasma.
 */
export interface ItemInvalido {
  codigo: string;
  descricao: string;
}

export type VendabilidadeResult =
  | { status: 'ok' }
  | { status: 'inativos'; itens: ItemInvalido[] }
  | { status: 'erro'; message: string };

/**
 * Puro: dado o conjunto de ids vendáveis (ativo=true confirmado no banco), retorna
 * os itens do carrinho que NÃO estão nele (inativos ou ausentes). Dedupe por id; um
 * id vazio é tratado como não-vendável (fail-closed — não dá pra confirmar).
 */
export function itensNaoVendaveis(
  cartItems: ProductCartItem[],
  vendaveisIds: Set<string>,
): ItemInvalido[] {
  const seen = new Set<string>();
  const out: ItemInvalido[] = [];
  for (const c of cartItems) {
    const id = c.product.id;
    if (id && vendaveisIds.has(id)) continue; // vendável
    const key = id || `${c.product.codigo}|${c.product.descricao}`;
    if (seen.has(key)) continue; // dedupe (mesmo produto repetido no carrinho)
    seen.add(key);
    out.push({ codigo: c.product.codigo, descricao: c.product.descricao });
  }
  return out;
}

/**
 * I/O: revalida `omie_products.ativo` para todos os product.id do carrinho.
 * O carrinho tem dezenas de itens no máximo → um único `.in()` (sem paginação) basta.
 */
export async function validarVendabilidade(
  supabase: SubmitClient,
  cartItems: ProductCartItem[],
): Promise<VendabilidadeResult> {
  if (cartItems.length === 0) return { status: 'ok' };

  const ids = [...new Set(cartItems.map((c) => c.product.id).filter(Boolean))];
  if (ids.length === 0) {
    // Há itens no carrinho mas NENHUM com id resolvível → não dá pra confirmar
    // vendabilidade (fail-closed). Sem isto, o `.filter(Boolean)` esvaziaria `ids`
    // e o early-return liberaria o submit (fail-OPEN).
    return { status: 'inativos', itens: itensNaoVendaveis(cartItems, new Set()) };
  }

  const { data, error } = await supabase.from('omie_products').select('id, ativo').in('id', ids);
  if (error) {
    return {
      status: 'erro',
      message:
        'Não foi possível validar a disponibilidade dos produtos (falha temporária). O pedido NÃO foi enviado — tente novamente.',
    };
  }

  const vendaveis = new Set(
    ((data ?? []) as Array<{ id: string; ativo: boolean }>)
      .filter((r) => r.ativo === true)
      .map((r) => r.id),
  );
  const itens = itensNaoVendaveis(cartItems, vendaveis);
  return itens.length === 0 ? { status: 'ok' } : { status: 'inativos', itens };
}

/** Mensagem de bloqueio pronta para o usuário, ou null se vendável (libera o submit). */
export function bloqueioVendabilidade(r: VendabilidadeResult): string | null {
  if (r.status === 'ok') return null;
  if (r.status === 'erro') return r.message;
  const lista = r.itens.map((i) => `${i.codigo} (${i.descricao})`).join(', ');
  return `Estes produtos foram desativados no Omie e não podem ser vendidos: ${lista}. Remova-os do carrinho para continuar.`;
}
