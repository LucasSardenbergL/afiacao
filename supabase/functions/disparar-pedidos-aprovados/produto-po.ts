// Item do IncluirPedCompra (`produtos_incluir`) — função PURA, testada em ./produto-po_test.ts.
//
// Preço exato do PO Sayerlack (spec docs/superpowers/specs/2026-10-05-preco-exato-po-sayerlack-design.md §5.4):
// quando a captura do portal provou o preço (RPC sayerlack_aplicar_custo_portal), o item traz a decomposição —
// unitário SEM IPI + IPI da linha — e o PO leva as duas, como a NF: `nValUnit` sem IPI e `nValorIpi`.
// Sem decomposição (fornecedor sem portal, captura cega, banco sem a migration 20261006120000) o PO sai como
// sempre: `nValUnit = preco_unitario` (o custo, que já inclui o IPI quando houve prova) e SEM `nValorIpi` — IPI
// ausente nunca vira 0 fabricado.

export interface ItemPo {
  sku_codigo_omie: string;
  qtde_final: number;
  preco_unitario: number;
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

/** Número finito vindo do PostgREST (numeric chega como number ou string); ausente/lixo ⇒ null, nunca 0. */
function numeroOuNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function montarProdutoIncluir(it: ItemPo, idx: number): ProdutoIncluir {
  const base = {
    cCodIntItem: `ITEM${String(idx + 1).padStart(3, "0")}`,
    nCodProd: Number(it.sku_codigo_omie),
    // [QTDE-INTEIRA] backstop universal: nenhum item de pedido pode ser fracionário. O estoque do Omie vem com poeira
    // decimal (tinta em litros) → qtde_final pode ser 3,99996. ceil aqui pega qualquer fonte (linha legada, edição
    // humana, promo, cold-start), mesmo que a RPC já ceile na origem. Math.ceil (não round) = nunca sub-pedir.
    nQtde: Math.ceil(Number(it.qtde_final)),
  };
  const semIpi = numeroOuNull(it.preco_unitario_sem_ipi_portal);
  const ipi = numeroOuNull(it.valor_ipi_portal);
  if (semIpi !== null && semIpi > 0 && ipi !== null && ipi >= 0) {
    return { ...base, nValUnit: semIpi, nValorIpi: ipi };
  }
  return { ...base, nValUnit: Number(it.preco_unitario) };
}
