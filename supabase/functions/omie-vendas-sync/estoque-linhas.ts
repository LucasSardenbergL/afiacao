// Linhas de UPDATE de `omie_products.estoque` a partir de uma página do ListarPosEstoque
// (action `sync_estoque`). Testes: estoque-linhas_test.ts.
//
// AUSENTE ≠ ZERO. Antes era `estoque: Number(prod.nSaldo ?? 0)`: produto listado SEM `nSaldo`
// gravava saldo 0, e a busca do Novo Pedido (`seloEstoque`, #4068) mostrava "Est: 0" vermelho
// para um saldo que ninguém informou (`nSaldo` lixo virava `NaN`, que o JSON do PATCH serializa
// como null — gravava NULL por acidente; parecer Codex).
//
// Sem saldo EXPLÍCITO o produto NÃO é tocado (nem `estoque`, nem `updated_at`) — e não gravado
// como NULL. Mesma regra do escritor canônico (`_shared/pos-estoque.ts`, `acumularPosicoesDaPagina`:
// "sem ele o item sai do retrato"), pelos mesmos motivos:
//   • esta edge é `positivos-parcial` no registro de escritores (não é dona do zero): um lote que
//     veio sem o campo não pode apagar o último saldo EXPLÍCITO que outro escritor gravou;
//   • o zeramento confirmado (`_shared/zeramento-estoque.ts`) pula linha NULL — um NULL gravado
//     aqui ficaria grudado mesmo depois de o saldo real ir a 0;
//   • o campo ausente num item listado é anomalia de contrato (o ListarPosEstoque padrão só lista
//     saldo ≠ 0) — o desfecho honesto é contá-lo no log, não inventar valor para ele.
// Zero REAL (o Omie mandou 0) continua 0.
import { codigoExplicito, numeroExplicito } from "../_shared/pos-estoque.ts";

export interface ItemPosEstoqueVendas {
  nCodProd?: unknown;
  nSaldo?: unknown;
}

interface LinhaEstoque<A extends string = string> {
  id: string;
  omie_codigo_produto: number;
  account: A;
  estoque: number;
  updated_at: string;
}

export interface PlanoEstoque<A extends string = string> {
  linhas: LinhaEstoque<A>[];
  /** Produtos locais que vieram sem saldo explícito — não tocados. */
  semSaldo: number[];
}

export function planejarLinhasEstoque<A extends string>(
  produtos: ItemPosEstoqueVendas[],
  idPorCodigo: Map<number, string>,
  account: A,
  updatedAt: string,
): PlanoEstoque<A> {
  const linhas: LinhaEstoque<A>[] = [];
  const semSaldo: number[] = [];
  for (const prod of produtos) {
    // `Number([123])` é 123: coagir o código grava o saldo no SKU errado (Codex) — só código explícito.
    const omieCodigoProduto = codigoExplicito(prod.nCodProd);
    const existingId = omieCodigoProduto === null ? undefined : idPorCodigo.get(omieCodigoProduto);
    if (omieCodigoProduto === null || !existingId) continue;
    const saldo = numeroExplicito(prod.nSaldo);
    if (saldo === null) {
      semSaldo.push(omieCodigoProduto);
      continue;
    }
    linhas.push({ id: existingId, omie_codigo_produto: omieCodigoProduto, account, estoque: saldo, updated_at: updatedAt });
  }
  return { linhas, semSaldo };
}
