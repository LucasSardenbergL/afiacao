// Resolve omie_codigo_produto -> product_id a partir de linhas de omie_products, NULIFICANDO
// o código AMBÍGUO. money-path: omie_products é UNIQUE (omie_codigo_produto, account) e
// `account` é convenção EMPRESA (oben/colacor/colacor_sc — docs/agent/database.md §5), então o
// MESMO número de código pode existir em >1 empresa. Resolver account-blind com last-wins
// gravaria o CMC/saldo lido de UMA empresa no product_id de OUTRA (contaminação cross-company →
// custo errado no EOQ da Reposição). Precisão > recall: na dúvida, não grava (product_id null).
// O caller filtra omie_products por empresa (.eq("account", accountToEmpresa(account))) ANTES de
// chamar isto — então, com UNIQUE(código,account), NÃO deve sobrar ambíguo; este guard é o
// defense-in-depth se o filtro/constraint falhar (degrada p/ null, nunca grava no errado).
//
// "Ambíguo" = 2+ product_ids DISTINTOS para o mesmo código (NÃO "2+ ocorrências"): a paginação
// .range() do syncInventoryFull pode repetir a MESMA linha (mesmo id) — repetição de paginação
// não pode custar a cobertura de CMC de um produto legítimo. É o mesmo guard que o syncInventory
// já fazia inline (idByCod.set(cod, has(cod) ? null : id)), agora unificado e testado.
export function buildProductIdMap(
  rows: Array<{ id: string | null; omie_codigo_produto: number | string | null }>,
): Map<number, string | null> {
  const map = new Map<number, string | null>();
  for (const r of rows) {
    if (r.omie_codigo_produto == null || r.id == null) continue;
    const cod = Number(r.omie_codigo_produto);
    if (!Number.isSafeInteger(cod) || cod <= 0) continue; // só inteiro positivo SEGURO (0/neg/frac/NaN/>2^53 fora — Number(null/"")===0 nunca vira entrada)
    const id = String(r.id);
    if (!map.has(cod)) {
      map.set(cod, id);
    } else {
      const atual = map.get(cod);
      if (atual !== null && atual !== id) map.set(cod, null); // 2+ ids distintos → ambíguo
    }
  }
  return map;
}
