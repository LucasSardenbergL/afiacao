import type { Product } from '@/hooks/unifiedOrder/types';

/**
 * "Repetir pedido": decide, item a item do jsonb `sales_orders.items`, como o
 * pedido antigo vira carrinho novo no wizard:
 * - produto comum no catálogo → entra DIRETO (quantidade do pedido antigo,
 *   PREÇO ATUAL do cliente — decisão do founder 2026-06-09, nunca o preço velho);
 * - base tintométrica → FILA DE TINTA (o TintColorSelectDialog abre um a um,
 *   pré-buscado com a cor daquela compra — humano confirma preço/embalagem);
 * - fora do catálogo → listado pro aviso (nada some em silêncio).
 *
 * Função pura (testada) — a busca do pedido e a aplicação ficam no wizard.
 */

export interface ItemDireto {
  product: Product;
  quantidade: number;
}

export interface ItemTinta {
  product: Product;
  /** Cor do pedido antigo (pré-busca do dialog); null = base vendida sem cor gravada. */
  nomeCor: string | null;
  quantidade: number;
}

export interface PlanoReplicacao {
  diretos: ItemDireto[];
  tintas: ItemTinta[];
  /** Descrições dos itens que não puderam entrar (fora do catálogo carregado). */
  foraDoCatalogo: string[];
}

interface ItemJson {
  descricao?: unknown;
  quantidade?: unknown;
  omie_codigo_produto?: unknown;
  tint_nome_cor?: unknown;
}

export function montarPlanoReplicacao(items: unknown, catalogo: Product[]): PlanoReplicacao {
  const plano: PlanoReplicacao = { diretos: [], tintas: [], foraDoCatalogo: [] };
  if (!Array.isArray(items)) return plano;

  const porCodigo = new Map<number, Product>();
  for (const p of catalogo) porCodigo.set(p.omie_codigo_produto, p);

  for (const raw of items as ItemJson[]) {
    if (!raw || typeof raw !== 'object') continue;
    const codigo = typeof raw.omie_codigo_produto === 'number' ? raw.omie_codigo_produto : null;
    const descricao =
      typeof raw.descricao === 'string' && raw.descricao.trim() ? raw.descricao : 'Item sem descrição';
    const qtd =
      typeof raw.quantidade === 'number' && Number.isFinite(raw.quantidade) && raw.quantidade >= 1
        ? raw.quantidade
        : 1;

    const product = codigo != null ? porCodigo.get(codigo) : undefined;
    if (!product) {
      plano.foraDoCatalogo.push(descricao);
      continue;
    }

    if (product.is_tintometric && product.tint_type === 'base') {
      const nomeCor =
        typeof raw.tint_nome_cor === 'string' && raw.tint_nome_cor.trim() ? raw.tint_nome_cor.trim() : null;
      plano.tintas.push({ product, nomeCor, quantidade: qtd });
    } else {
      plano.diretos.push({ product, quantidade: qtd });
    }
  }

  return plano;
}
