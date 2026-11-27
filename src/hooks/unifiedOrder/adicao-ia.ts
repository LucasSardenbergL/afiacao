// Adição ao carrinho do que a IA identificou — PURO (PR 3.1 do Novo Pedido, "IA honesta").
//
// Até aqui `handleUnifiedAIResult` (useUnifiedOrder.ts) fazia três coisas erradas, sem dizer nada:
//   1. pulava em silêncio o produto fora do catálogo carregado e a ferramenta já no pedido, e o
//      assistente anunciava "N adicionados" contando o que NÃO entrou;
//   2. somava a quantidade em TODAS as linhas do mesmo produto, inclusive nas de outra cor
//      (`tint_formula_id`) — a "base 18L branca" ganhava as latas pedidas para a cor;
//   3. punha a base tintométrica direto no carrinho, sem cor, furando o fluxo de cor que a lista
//      (`addProductToCart`) e o "Repetir pedido" (`tintQueue`) já respeitam.
//
// Aqui cada item sai com um DESFECHO e o motivo, a soma só entra na linha SEM cor (a mesma regra do
// `addProductToCart` em useCart.ts), e a base vai para a fila de cor. O caller aplica o plano com
// `aplicarAdicaoIA` sobre o `prev` do setCart, então a decisão não depende de o carrinho do render
// estar fresco.
import type { CartItem, Product, ProductCartItem, ServiceCartItem, UserTool } from './types';
import type { OmieServico } from '@/services/omieService';
import type { ItemTinta } from '@/lib/pedido/replicar-pedido';
import type { AIOrderResult, DesfechoItemIA, ItemRelatorioIA, RelatorioAdicaoIA } from '@/components/unifiedAI/types';
import type { ContagemRelatorio } from '@/components/unifiedAI/helpers';

export interface PlanoAdicaoIA {
  /** Linhas novas, na ordem da análise. */
  novas: CartItem[];
  /** Quantidade a somar na linha SEM cor já existente de cada produto. */
  somas: Map<string, number>;
  relatorio: RelatorioAdicaoIA;
}

export function ehBaseTintometrica(product: Pick<Product, 'is_tintometric' | 'tint_type'>): boolean {
  return !!product.is_tintometric && product.tint_type === 'base';
}

/** A linha de produto em que uma soma pode cair: mesmo produto, SEM cor. */
export function ehLinhaSomavel(c: CartItem, productId: string): c is ProductCartItem {
  return c.type === 'product' && c.product.id === productId && !c.tint_formula_id;
}

export function planejarAdicaoIA(args: {
  carrinho: ReadonlyArray<CartItem>;
  resultado: AIOrderResult;
  catalogo: ReadonlyArray<Product>;
  userTools: ReadonlyArray<UserTool>;
  servicos: ReadonlyArray<OmieServico>;
  nascer: (product: Product, quantidade: number) => ProductCartItem;
}): PlanoAdicaoIA {
  const { carrinho, resultado, catalogo, userTools, servicos, nascer } = args;
  const novas: CartItem[] = [];
  const novasPorProduto = new Map<string, ProductCartItem>();
  const somas = new Map<string, number>();
  const itens: ItemRelatorioIA[] = [];
  const tintas: ItemTinta[] = [];

  const registrar = (
    tipo: ItemRelatorioIA['tipo'], descricao: string, desfecho: DesfechoItemIA,
    quantidade: number, quantidadeInferida: boolean, motivo?: string,
  ) => itens.push({ tipo, descricao, desfecho, quantidade, quantidadeInferida, motivo });

  for (const aiProd of resultado.products) {
    const inferida = aiProd.quantidade_inferida !== false;
    const product = catalogo.find(p => p.id === aiProd.product_id);
    if (!product) {
      registrar('produto', aiProd.descricao || aiProd.codigo || 'Produto', 'descartado', aiProd.quantity, inferida,
        'não está no catálogo carregado nesta tela — busque pelo código');
      continue;
    }
    if (ehBaseTintometrica(product)) {
      tintas.push({ product, nomeCor: null, quantidade: aiProd.quantity });
      registrar('produto', product.descricao, 'cor', aiProd.quantity, inferida,
        'base de tinta: escolha a cor na janela que abriu');
      continue;
    }
    const pendente = novasPorProduto.get(product.id);
    if (pendente) {
      pendente.quantity += aiProd.quantity;
      registrar('produto', product.descricao, 'somado', aiProd.quantity, inferida,
        'repetido nesta análise — somado à mesma linha');
      continue;
    }
    if (carrinho.some(c => ehLinhaSomavel(c, product.id))) {
      somas.set(product.id, (somas.get(product.id) ?? 0) + aiProd.quantity);
      registrar('produto', product.descricao, 'somado', aiProd.quantity, inferida,
        'já estava no pedido — a quantidade foi somada');
      continue;
    }
    // A IA NÃO precifica: nasce pela MESMA função da lista (nascimento-item.ts).
    const linha = nascer(product, aiProd.quantity);
    novas.push(linha);
    novasPorProduto.set(product.id, linha);
    registrar('produto', product.descricao, 'adicionado', aiProd.quantity, inferida);
  }

  const ferramentasNovas = new Set<string>();
  for (const aiSvc of resultado.services) {
    const inferida = aiSvc.quantidade_inferida !== false;
    const tool = userTools.find(t => t.id === aiSvc.userToolId);
    const rotulo = aiSvc.servico_descricao || 'Serviço de afiação';
    if (!tool) {
      registrar('servico', rotulo, 'descartado', aiSvc.quantity, inferida,
        'a ferramenta não está carregada para este cliente');
      continue;
    }
    const jaNoPedido = carrinho.some(c => c.type === 'service' && (c as ServiceCartItem).userTool.id === tool.id);
    if (jaNoPedido || ferramentasNovas.has(tool.id)) {
      registrar('servico', rotulo, 'descartado', aiSvc.quantity, inferida,
        'esta ferramenta já está no pedido');
      continue;
    }
    const servico = servicos.find(s => s.omie_codigo_servico === aiSvc.omie_codigo_servico) || null;
    ferramentasNovas.add(tool.id);
    novas.push({ type: 'service', userTool: tool, servico, quantity: aiSvc.quantity, notes: aiSvc.notes, photos: [] });
    registrar('servico', rotulo, 'adicionado', aiSvc.quantity, inferida,
      servico ? undefined : 'o serviço não foi reconhecido — escolha-o no carrinho');
  }

  return { novas, somas, relatorio: { itens, tintas } };
}

/** Aplica o plano sobre o carrinho ATUAL (o `prev` do setCart). */
export function aplicarAdicaoIA(prev: ReadonlyArray<CartItem>, plano: PlanoAdicaoIA): CartItem[] {
  const somados = prev.map(c => {
    if (c.type !== 'product' || c.tint_formula_id) return c;
    const soma = plano.somas.get(c.product.id);
    return soma ? ({ ...c, quantity: c.quantity + soma } as ProductCartItem) : c;
  });
  return plano.novas.length > 0 ? [...somados, ...plano.novas] : somados;
}

/** Relatório de quando NADA pode entrar (carrinho travado no envio): todo item descartado, com o motivo. */
export function relatorioTudoDescartado(resultado: AIOrderResult, motivo: string): RelatorioAdicaoIA {
  return {
    itens: [
      ...resultado.products.map(p => ({
        tipo: 'produto' as const, descricao: p.descricao || p.codigo || 'Produto', desfecho: 'descartado' as const,
        quantidade: p.quantity, quantidadeInferida: p.quantidade_inferida !== false, motivo,
      })),
      ...resultado.services.map(s => ({
        tipo: 'servico' as const, descricao: s.servico_descricao || 'Serviço de afiação', desfecho: 'descartado' as const,
        quantidade: s.quantity, quantidadeInferida: s.quantidade_inferida !== false, motivo,
      })),
    ],
    tintas: [],
  };
}

/** Contagem por desfecho — o que o anúncio e o sensor dizem. Só `adicionado`+`somado` ENTROU. */
export function contarRelatorio(r: RelatorioAdicaoIA): ContagemRelatorio {
  const c: ContagemRelatorio = { entrou: 0, adicionado: 0, somado: 0, cor: 0, descartado: 0, inferidas: 0 };
  for (const i of r.itens) {
    c[i.desfecho] += 1;
    if (i.desfecho === 'adicionado' || i.desfecho === 'somado') c.entrou += 1;
    // Inferida conta em tudo que SEGUE (carrinho ou fila de cor): é o que o vendedor tem de conferir.
    if (i.desfecho !== 'descartado' && i.quantidadeInferida) c.inferidas += 1;
  }
  return c;
}
