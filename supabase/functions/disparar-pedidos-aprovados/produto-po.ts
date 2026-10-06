// Itens do IncluirPedCompra (`produtos_incluir`) — função PURA, testada em ./produto-po_test.ts.
//
// Preço exato do PO Sayerlack (spec docs/superpowers/specs/2026-10-05-preco-exato-po-sayerlack-design.md §5.4):
// quando a captura do portal provou o preço (RPC sayerlack_aplicar_custo_portal), cada item traz a decomposição —
// unitário SEM IPI + IPI da linha — e o PO leva as duas, como a NF: `nValUnit` sem IPI e `nValorIpi`.
// A decomposição só vale com o pedido INTEIRO decomposto e cada item ainda coerente com o custo da linha
// (`unitário sem IPI × qtde + IPI = valor_linha`): quantidade ou preço editados depois da captura deixam o IPI da
// linha velho (ele não escala com a quantidade). Sem isso — fornecedor sem portal, captura cega, banco sem a
// migration 20261006120000, decomposição parcial ou velha — o PO sai como sempre para TODOS os itens:
// `nValUnit = preco_unitario` (o custo, que já inclui o IPI quando houve prova) e SEM `nValorIpi`. Nunca PO misto;
// IPI ausente nunca vira 0 fabricado.

export interface ItemPo {
  sku_codigo_omie: string;
  qtde_final: number;
  preco_unitario: number;
  valor_linha?: number | string | null;
  preco_unitario_sem_ipi_portal?: number | string | null;
  valor_ipi_portal?: number | string | null;
}

export interface ProdutoIncluir {
  cCodIntItem: string;
  nCodProd: number;
  nQtde: number;
  nValUnit: number;
  nValorIpi?: number;
}

/** completa = todo item decomposto e coerente · ausente = nenhum item tem decomposição · parcial = só parte dos
 *  itens tem · incoerente = algum item tem decomposição inválida ou que não bate mais com o custo da linha. */
export type DecomposicaoPo = "completa" | "ausente" | "parcial" | "incoerente";

/** Número finito vindo do PostgREST (numeric chega como number ou string); ausente/lixo ⇒ null, nunca 0. */
function numeroOuNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Folga da coerência: meio centavo — o unitário sem IPI é `linha ÷ qtde` em numeric, e o float só erra na 12ª casa. */
const FOLGA_COERENCIA = 0.005;

function decomposicaoCoerente(it: ItemPo): { semIpi: number; ipi: number } | null {
  const semIpi = numeroOuNull(it.preco_unitario_sem_ipi_portal);
  const ipi = numeroOuNull(it.valor_ipi_portal);
  const linha = numeroOuNull(it.valor_linha);
  const qtde = numeroOuNull(it.qtde_final);
  if (semIpi === null || semIpi <= 0 || ipi === null || ipi < 0 || linha === null || linha <= 0 || qtde === null || qtde <= 0) {
    return null;
  }
  return Math.abs(semIpi * qtde + ipi - linha) <= FOLGA_COERENCIA ? { semIpi, ipi } : null;
}

export function montarProdutosIncluir(itens: ItemPo[]): { produtos: ProdutoIncluir[]; decomposicao: DecomposicaoPo } {
  const coerentes = itens.map(decomposicaoCoerente);
  const comAlgo = itens.map((it) => it.preco_unitario_sem_ipi_portal != null || it.valor_ipi_portal != null);
  const decomposicao: DecomposicaoPo = itens.length > 0 && coerentes.every((d) => d !== null) ? "completa"
    : !comAlgo.some(Boolean) ? "ausente"
    : comAlgo.some((tem, i) => tem && coerentes[i] === null) ? "incoerente"
    : "parcial";
  const produtos = itens.map((it, idx): ProdutoIncluir => {
    const base = {
      cCodIntItem: `ITEM${String(idx + 1).padStart(3, "0")}`,
      nCodProd: Number(it.sku_codigo_omie),
      // [QTDE-INTEIRA] backstop universal: nenhum item de pedido pode ser fracionário. O estoque do Omie vem com poeira
      // decimal (tinta em litros) → qtde_final pode ser 3,99996. ceil aqui pega qualquer fonte (linha legada, edição
      // humana, promo, cold-start), mesmo que a RPC já ceile na origem. Math.ceil (não round) = nunca sub-pedir.
      nQtde: Math.ceil(Number(it.qtde_final)),
    };
    const d = coerentes[idx];
    if (decomposicao === "completa" && d !== null) return { ...base, nValUnit: d.semIpi, nValorIpi: d.ipi };
    return { ...base, nValUnit: Number(it.preco_unitario) };
  });
  return { produtos, decomposicao };
}
