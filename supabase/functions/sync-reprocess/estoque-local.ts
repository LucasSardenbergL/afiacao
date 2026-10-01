// Leitura das linhas locais com estoque ≠ 0 — as candidatas ao zeramento de quem saiu da lista
// de posição (inventory-lote.ts, planejarZeramentoForaDaLista). Fora do index.ts porque o gate
// `paginacao-delegada_test.ts` só vigia o call-site; o contrato daqui é de estoque-local_test.ts.
// KEYSET, não offset: o filtro é sobre `estoque`, que o sync_inventory de 30 min reescreve — com
// offset, linha que entra no recorte entre páginas devolve a anterior DUPLICADA, e duplicata no
// mesmo upsert derruba o chunk com 21000. O helper LANÇA em página que falha: lista vazia por
// falha de transporte pareceria "ninguém a zerar" (money-path.md §6).
import { type BancoPostgrest, fetchAllKeyset } from "../_shared/paginate.ts";
import type { LinhaProdutoLocal } from "./inventory-lote.ts";

type LinhaComId = LinhaProdutoLocal & { id: string };

export async function carregarEstoqueLocalNaoZero(
  db: BancoPostgrest,
  account: string,
): Promise<LinhaProdutoLocal[]> {
  return await fetchAllKeyset<LinhaComId, string>(
    (cursor, limite) => {
      let q = db.from<LinhaComId>("omie_products")
        .select("id, omie_codigo_produto, estoque, codigo, descricao")
        .eq("account", account)
        .not("estoque", "eq", 0);
      if (cursor !== null) q = q.gt("id", cursor);
      return q.order("id", { ascending: true }).limit(limite);
    },
    (l) => l.id,
    "omie_products (estoque≠0)",
  );
}
