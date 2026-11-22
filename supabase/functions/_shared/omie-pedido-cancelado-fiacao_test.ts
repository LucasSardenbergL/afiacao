// FIAÇÃO do "cancelado no Omie vence a etapa" (decisão do founder 2026-11-21). O helper puro é
// provado em omie-pedido_test.ts; aqui o pino é que os DOIS escritores de status o usam com a
// marca do PRÓPRIO pedido — e que nenhum mapa etapa→status inline sobreviveu (foi um mapa inline
// só com etapa 80 que deixou ~R$ 8,3 mi de pedido cancelado contando como venda).
// Roda: deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/

const raiz = new URL("../", import.meta.url);
const ler = (rel: string) => Deno.readTextFile(new URL(rel, raiz));

function exigir(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

Deno.test("omie-vendas-sync: os dois pontos de status usam omieStatusDoPedido com a marca do pedido", async () => {
  const src = await ler("omie-vendas-sync/index.ts");
  exigir(
    src.includes("omieStatusDoPedido(cab.etapa, pedido.infoCadastro)"),
    "[FIO-SYNC] syncPedidos não passa a marca infoCadastro do pedido listado",
  );
  exigir(
    src.includes("omieStatusDoPedido(cab.etapa, pv.infoCadastro)"),
    "[FIO-REPARO] repararOrfaosItens não passa a marca infoCadastro do pedido consultado",
  );
  exigir(
    !/etapa\s*===\s*['"]80['"]/.test(src),
    "[MAPA-INLINE] voltou um mapa etapa→status inline (cego à marca de cancelado)",
  );
});

Deno.test("sync-reprocess: o status enviado à RPC vem de statusOmieReconciliavel com a marca", async () => {
  const src = await ler("sync-reprocess/index.ts");
  exigir(
    src.includes("status_omie: statusOmieReconciliavel(cab.etapa, pedido.infoCadastro)"),
    "[FIO-REPROCESS] status_omie não considera a marca de cancelado",
  );
  exigir(
    !src.includes("omieEtapaToStatus(cab.etapa)"),
    "[MAPA-SO-ETAPA] o reprocess voltou a mapear só pela etapa",
  );
});
