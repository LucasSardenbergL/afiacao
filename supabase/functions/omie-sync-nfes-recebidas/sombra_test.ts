// Testa o CÓDIGO REAL de sombra.ts (orquestração da sombra da associação NF↔PO) no runtime Deno, com porta falsa.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-sync-nfes-recebidas/sombra_test.ts
//
// O contrato com o laço principal: a sombra NUNCA lança (o vínculo NF↔PO já foi feito e não pode ser desfeito por
// ela), cede quando falta tempo, e cada desfecho cai num contador próprio — falha não some num `erros` genérico.
import { contratosDoDetalhe, executarSombra, novaSombraSummary, type PortaSombra } from "./sombra.ts";
import type { PedidoDoContrato } from "./associacao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg ? `${msg}: ` : ""}esperado ${jb}, veio ${ja}`);
}

const NF = { empresa: "OBEN", nIdReceb: 12196962110, numero_nfe: "000955263", chave_nfe: "4".repeat(44), fornecedor_codigo_omie: 8689681266 };
const detalhe = {
  cabec: { cCancelada: "N", cRecebido: "N", cDevolvido: "N", cDevolvidoParc: "N" },
  itensRecebimento: [{
    itensCabec: { nSequencia: 1, nIdProduto: 501, nIdItPedido: 0, cIgnorarItem: "N", cItemDevolvido: "N" },
    itensAjustes: { nQtdeRecebida: 2, cUnidade: "GL", cNaoGerarMovEstoque: "N" },
    itensInfoAdic: { nNumPedCompra: "2138394" },
  }],
};
const pedido: PedidoDoContrato = {
  omie_codigo_pedido: 9001, numero_pedido: "1263", fornecedor_codigo_omie: 8689681266,
  itens: [{ nCodItem: 77, nCodProd: 501, nQtde: 2, cUnidade: "GL" }],
};

function porta(over: Partial<PortaSombra> = {}) {
  const chamadas = { buscar: [] as string[][], publicar: [] as Record<string, unknown>[] };
  const p: PortaSombra = {
    buscarPedidos: over.buscarPedidos ?? (async (c) => { chamadas.buscar.push(c); return new Map([["2138394", [pedido]]]); }),
    publicar: over.publicar ?? (async (l) => { chamadas.publicar.push(l); return "gravada"; }),
  };
  return { p, chamadas };
}
const sempre = () => true;

Deno.test("caminho feliz: classifica, publica a proposta e conta gravada", async () => {
  const { p, chamadas } = porta();
  const r = novaSombraSummary();
  const c = await executarSombra(p, NF, detalhe, new Set(), "2026-10-17T10:00:00Z", sempre, r);
  assertEquals(c?.classe, "associavel");
  assertEquals(chamadas.buscar, [["2138394"]], "busca pelo contrato");
  assertEquals(chamadas.publicar[0].pares, [{ nSequencia: 1, nIdPedido: 9001, nIdItPedido: 77, quantidade: 2, unidade: "GL" }]);
  assertEquals([chamadas.publicar[0].observado_em, chamadas.publicar[0].versao_classificador], ["2026-10-17T10:00:00Z", "assoc-sombra-v1"]);
  assertEquals(r, { tentadas: 1, classificadas: 1, gravadas: 1, leituras_velhas: 0, falhas: 0, puladas_por_tempo: 0, por_classe: { associavel: 1 } });
});

Deno.test("leitura velha é contada à parte", async () => {
  const { p } = porta({ publicar: async () => "leitura_velha" });
  const r = novaSombraSummary();
  await executarSombra(p, NF, detalhe, new Set(), "t", sempre, r);
  assertEquals([r.gravadas, r.leituras_velhas, r.falhas], [0, 1, 0]);
});

Deno.test("falha de leitura, de publicação ou resposta estranha: NUNCA lança, conta falha", async () => {
  for (const over of [
    { buscarPedidos: async () => { throw new Error("timeout"); } },
    { publicar: async () => { throw new Error("42501"); } },
    { publicar: async () => "ok?" },
  ] as Partial<PortaSombra>[]) {
    const r = novaSombraSummary();
    const c = await executarSombra(porta(over).p, NF, detalhe, new Set(), "t", sempre, r);
    assertEquals([c, r.tentadas, r.falhas, r.gravadas], [null, 1, 1, 0]);
  }
});

Deno.test("sem tempo: cede antes de tocar a porta", async () => {
  const { p, chamadas } = porta();
  const r = novaSombraSummary();
  const c = await executarSombra(p, NF, detalhe, new Set(), "t", () => false, r);
  assertEquals([c, r.tentadas, r.puladas_por_tempo, chamadas.buscar.length, chamadas.publicar.length], [null, 0, 1, 0, 0]);
});

Deno.test("órfã não busca nada e ainda publica a classificação; contrato composto não vira busca", async () => {
  const semContrato = { ...detalhe, itensRecebimento: [{ ...detalhe.itensRecebimento[0], itensInfoAdic: {} }] };
  const { p, chamadas } = porta();
  const r = novaSombraSummary();
  const c = await executarSombra(p, NF, semContrato, new Set(), "t", sempre, r);
  assertEquals([c?.classe, chamadas.buscar.length, chamadas.publicar.length], ["orfa", 0, 1]);
  assertEquals(contratosDoDetalhe({ itensRecebimento: [{ itensInfoAdic: { nNumPedCompra: " 21/22 " } }, { itensInfoAdic: { nNumPedCompra: 7 } }, { itensInfoAdic: { nNumPedCompra: "0" } }] }), ["21/22", "7"]);
  const comp = { ...detalhe, itensRecebimento: [{ ...detalhe.itensRecebimento[0], itensInfoAdic: { nNumPedCompra: "21/22" } }] };
  const x = porta();
  const c2 = await executarSombra(x.p, NF, comp, new Set(), "t", sempre, novaSombraSummary());
  assertEquals([c2?.motivos, x.chamadas.buscar.length], [["contrato_composto"], 0]);
});
