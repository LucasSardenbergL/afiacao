// Testa o CÓDIGO REAL de sombra.ts (orquestração da sombra da associação NF↔PO) no runtime Deno, com porta falsa.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-sync-nfes-recebidas/sombra_test.ts
//
// Contrato com o run (pareceres Codex 2026-10-16/17): a sombra NUNCA lança, é uma fase posterior que cede quando falta
// tempo, publica o estado decidido pela NF sem buscar POs, invalida a proposta quando a busca falha, e mantém
// tentadas = gravadas + leituras_velhas + falhas_publicacao.
import {
  contratosDoDetalhe,
  executarFaseSombra,
  executarSombra,
  type ItemFilaSombra,
  novaSombraSummary,
  type PortaSombra,
  type SombraSummary,
} from "./sombra.ts";
import type { PedidoDoContrato } from "./associacao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg ? `${msg}: ` : ""}esperado ${jb}, veio ${ja}`);
}
const invariante = (r: SombraSummary) =>
  assertEquals(r.tentadas, r.gravadas + r.leituras_velhas + r.falhas_publicacao, "tentadas = gravadas + velhas + falhas_publicacao");

const NF = { empresa: "OBEN", nIdReceb: 12196962110, numero_nfe: "000955263", chave_nfe: "4".repeat(44), fornecedor_codigo_omie: 8689681266 };
// Formato medido (associacao.ts): flags em infoCadastro, pendente = cEtapa "40", item pendente sem nIdItPedido.
const detalhe = {
  cabec: { cEtapa: "40", nIdReceb: 12196962110 },
  infoCadastro: { cCancelada: "N", cRecebido: "N", cDevolvido: "N" },
  itensRecebimento: [{
    itensCabec: { nSequencia: 1, nIdProduto: 501, cIgnorarItem: "N" },
    itensAjustes: { nQtdeRecebida: 2, cUnidade: "GL", cNaoGerarMovEstoque: "N" },
    itensInfoAdic: { nNumPedCompra: "2138394" },
  }],
};
const cancelada = { ...detalhe, infoCadastro: { ...detalhe.infoCadastro, cCancelada: "S" } };
const pedido: PedidoDoContrato = {
  omie_codigo_pedido: 9001, numero_pedido: "1263", fornecedor_codigo_omie: 8689681266, etapa: "15",
  itens: [{ nCodItem: 77, nCodProd: 501, nQtde: 2, cUnidade: "GL" }],
};

function porta(over: Partial<PortaSombra> = {}) {
  const chamadas = { buscar: [] as string[][], publicar: [] as Record<string, unknown>[] };
  const p: PortaSombra = {
    buscarPedidos: over.buscarPedidos ?? (async (c) => { chamadas.buscar.push(c); return new Map([["2138394", [pedido]]]); }),
    publicar: async (l) => { chamadas.publicar.push(l); return over.publicar ? await over.publicar(l) : "gravada"; },
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
  assertEquals([chamadas.publicar[0].observado_em, chamadas.publicar[0].versao_classificador], ["2026-10-17T10:00:00Z", "assoc-sombra-v2"]);
  assertEquals(r, { tentadas: 1, gravadas: 1, leituras_velhas: 0, falhas_publicacao: 0, leituras_po_falhas: 0, puladas_por_tempo: 0, por_classe: { associavel: 1 } });
});

Deno.test("leitura velha é contada à parte", async () => {
  const r = novaSombraSummary();
  await executarSombra(porta({ publicar: async () => "leitura_velha" }).p, NF, detalhe, new Set(), "t", sempre, r);
  assertEquals([r.gravadas, r.leituras_velhas, r.falhas_publicacao], [0, 1, 0]);
  invariante(r);
});

Deno.test("estado decidido pela NF (cancelada) publica SEM buscar POs — invalida mesmo com a busca quebrada", async () => {
  const { p, chamadas } = porta({ buscarPedidos: async () => { throw new Error("timeout"); } });
  const r = novaSombraSummary();
  const c = await executarSombra(p, NF, cancelada, new Set(), "t", sempre, r);
  assertEquals([c?.classe, c?.motivos, chamadas.publicar.length, r.leituras_po_falhas], ["fora_de_alcance", ["nf_cancelada"], 1, 0]);
  invariante(r);
});

Deno.test("falha na busca de POs publica AMBÍGUA (a proposta verde anterior não sobrevive)", async () => {
  const { p, chamadas } = porta({ buscarPedidos: async () => { throw new Error("timeout"); } });
  const r = novaSombraSummary();
  const c = await executarSombra(p, NF, detalhe, new Set(), "t", sempre, r);
  assertEquals([c?.classe, c?.motivos, c?.pares], ["ambigua", ["leitura_po_falhou", "pedidos_nao_consultados"], []]);
  assertEquals([chamadas.publicar.length, chamadas.publicar[0].classe, r.leituras_po_falhas, r.gravadas], [1, "ambigua", 1, 1]);
  invariante(r);
});

Deno.test("falha de publicação ou resposta estranha: NUNCA lança, conta falha_publicacao", async () => {
  for (const pub of [async () => { throw new Error("42501"); }, async () => "ok?"] as PortaSombra["publicar"][]) {
    const r = novaSombraSummary();
    const c = await executarSombra(porta({ publicar: pub }).p, NF, detalhe, new Set(), "t", sempre, r);
    assertEquals([c, r.tentadas, r.falhas_publicacao, r.gravadas], [null, 1, 1, 0]);
    invariante(r);
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
  const c = await executarSombra(p, NF, semContrato, new Set(), "t", sempre, novaSombraSummary());
  assertEquals([c?.classe, chamadas.buscar.length, chamadas.publicar.length], ["orfa", 0, 1]);
  assertEquals(contratosDoDetalhe({ itensRecebimento: [{ itensInfoAdic: { nNumPedCompra: " 21/22 " } }, { itensInfoAdic: { nNumPedCompra: 7 } }, { itensInfoAdic: { nNumPedCompra: "0" } }] }), ["21/22", "7"]);
  const comp = { ...detalhe, itensRecebimento: [{ ...detalhe.itensRecebimento[0], itensInfoAdic: { nNumPedCompra: "21/22" } }] };
  const x = porta();
  const c2 = await executarSombra(x.p, NF, comp, new Set(), "t", sempre, novaSombraSummary());
  assertEquals([c2?.motivos, x.chamadas.buscar.length], [["contrato_composto"], 0]);
});

Deno.test("fase: relógio esgota no meio — as NFs restantes ficam puladas, nenhuma toca a porta depois", async () => {
  const fila: ItemFilaSombra[] = [1, 2, 3, 4].map((n) => ({ nf: { ...NF, nIdReceb: n }, detalhe, observadoEm: "t" }));
  let agora = 0;
  const { p, chamadas } = porta({ publicar: async () => { agora += 10; return "gravada"; } });
  const r = novaSombraSummary();
  await executarFaseSombra(fila, p, async () => new Set(), () => agora < 20, r);
  assertEquals([r.tentadas, r.puladas_por_tempo, chamadas.publicar.map((l) => l.nid_receb)], [2, 2, [1, 2]]);
  invariante(r);
  const sem = novaSombraSummary();
  const y = porta();
  await executarFaseSombra(fila, y.p, async () => { throw new Error("não devia ler"); }, () => false, sem);
  assertEquals([sem.puladas_por_tempo, y.chamadas.publicar.length], [4, 0], "sem tempo nem lê equivalências");
});

Deno.test("fase: equivalência que lança vira null → ambígua, nunca associável", async () => {
  const { p, chamadas } = porta();
  const r = novaSombraSummary();
  await executarFaseSombra([{ nf: NF, detalhe, observadoEm: "t" }], p, async () => { throw new Error("rede"); }, sempre, r);
  assertEquals([chamadas.publicar[0].classe, chamadas.publicar[0].motivos], ["ambigua", ["equivalencia_nao_lida"]]);
});
