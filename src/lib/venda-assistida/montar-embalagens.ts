import { resolverSayerlack } from '@/lib/reposicao/sayerlack-sku';
import { litrosDaEmbalagem } from './preco-preparado';
import type { EmbalagemComEstoque } from './resolver-opcao';

/**
 * Monta as embalagens da base/catalisador pro resolver da venda assistida (Fatia 2).
 *
 * Liga os SKUs do casamento (linhas de omie_products) ao de-para de litros (via parser Sayerlack) e
 * ao **preço-do-cliente** do wizard. PURO/testável — a query Supabase é um wrapper fino por cima.
 *
 * Litros: extrai o código Sayerlack da descrição → sufixo → `litrosDaEmbalagem`. SKU sem código
 * Sayerlack reconhecível → litros null → o resolver degrada honesto a "sob consulta".
 * Preço: último praticado pro cliente (se > 0) senão tabela (valor_unitario). ⚠️ Codex: o
 * preço-do-cliente NÃO é contratual (é o último praticado, copiado Oben↔Colacor) — a UI rotula.
 */

export interface ProdutoLinhaOmie {
  omie_codigo_produto: number;
  descricao: string;
  valor_unitario: number;
  estoque: number;
}

function precoDoCliente(
  cod: number,
  valorUnitario: number,
  customerPrices: Record<number, number>,
): number {
  const cp = customerPrices[cod];
  return typeof cp === 'number' && Number.isFinite(cp) && cp > 0 ? cp : valorUnitario;
}

export function montarBaseEmbalagens(
  produtos: ProdutoLinhaOmie[],
  customerPrices: Record<number, number>,
): EmbalagemComEstoque[] {
  return (produtos ?? []).map((p): EmbalagemComEstoque => {
    const res = resolverSayerlack(p.descricao);
    const sufixo = res.status === 'ok' ? res.sufixo : '';
    return {
      valor: precoDoCliente(p.omie_codigo_produto, p.valor_unitario, customerPrices ?? {}),
      litros: litrosDaEmbalagem(sufixo, p.descricao),
      estoque: Number.isFinite(p.estoque) ? p.estoque : 0,
    };
  });
}
