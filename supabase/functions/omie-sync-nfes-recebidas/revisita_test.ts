// Testa o CÓDIGO REAL de revisita.ts no runtime real (Deno), com o banco numa tabela em memória.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-sync-nfes-recebidas/revisita_test.ts
//
// Os casos de prod (OBEN/Sayerlack, 2026-10-17):
//   variante 2 — a NF 0935816 (08/05) já vinculada ao contrato 2091397 cobre também o 2091399, cuja linha
//                nasceu em 15/05: a revisita vincula a linha nova SEM consultar a Omie (contratos da listagem);
//   variante 3 — a NF 000936908 nunca foi listada pela janela de 3 dias: desconhecida → consulta → vincula.
// As falsificações que importam:
//   (a) NF conhecida vincula a linha que nasceu depois, com nid_receb, e NÃO chama ConsultarRecebimento;
//   (b) NF desconhecida consulta; sem linha nenhuma vira órfã; com linha, vincula e não vira órfã;
//   (c) linha com OUTRA NF fica intocada (a revisita nunca sobrescreve);
//   (d) CT-e, cancelada, sem fornecedor e já processada no run não são lidas nem consultadas;
//   (e) a NF mais ANTIGA vence a disputa pela mesma linha (o t2 é o 1º faturamento);
//   (f) falha na consulta não vira órfã; falha em `conhecidas` não revisita nada;
//   (g) sem tempo, conta as puladas e para;
//   (h) rodar de novo é no-op.
import type { LinhaPedido, NFeParaVinculo } from "./reconciliacao.ts";
import {
  type DocumentoRevisita,
  lerJanelaExplicita,
  lerRevisitaDias,
  novaRevisitaSummary,
  type PortaRevisita,
  revisitarJanela,
} from "./revisita.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg ? `${msg}: ` : ""}esperado ${jb}, veio ${ja}`);
}

const SAYERLACK = 8689681266;
const OUTRO_FORN = 1111;
const CHAVE_0935816 = "4".repeat(44);
const CHAVE_0936908 = "5".repeat(44);
const CHAVE_OUTRA = "6".repeat(44);

interface LinhaTabela extends LinhaPedido {
  contrato: string;
  fornecedor: number;
  nid_receb?: number | null;
  nfe_numero?: string | null;
}

function bruto(chave: string, numero: string, pedidos: string[], extra: Record<string, unknown> = {}): unknown {
  return {
    cabec: { cChaveNFe: chave, cNumeroNFe: numero, ...extra },
    itensRecebimento: pedidos.map((p) => ({ itensInfoAdic: { nNumPedCompra: p } })),
  };
}

function doc(nIdReceb: number, chave: string, numero: string, pedidos: string[], o: Partial<DocumentoRevisita> = {}): DocumentoRevisita {
  return {
    nIdReceb,
    chave,
    fornecedor: SAYERLACK,
    emissaoIso: "2026-05-08T00:00:00-03:00",
    cte: false,
    cancelada: false,
    bruto: bruto(chave, numero, pedidos),
    ...o,
  };
}

// O mapeador real (mapNFe) vive no index.ts, que sobe o Deno.serve — aqui um equivalente mínimo.
function mapear(raw: unknown): NFeParaVinculo {
  const cab = (raw as { cabec?: { cChaveNFe?: string; cNumeroNFe?: string; cancelada?: boolean } }).cabec ?? {};
  return {
    chave: cab.cChaveNFe ?? null,
    numero: cab.cNumeroNFe ?? null,
    serie: "1",
    data_emissao_iso: "2026-05-08T00:00:00-03:00",
    data_recebimento_iso: null,
    recebida: false,
    status: cab.cancelada ? "CANCELADO" : "FATURADO",
    transp_cnpj: null,
    transp_nome: null,
    fornecedor_nome: null,
    fornecedor_cnpj: null,
  };
}

function banco(
  linhas: LinhaTabela[],
  o: { conhecidas?: number[]; detalhes?: Record<number, unknown>; falharConhecidas?: boolean; falharConsulta?: number[] } = {},
) {
  const consultas: number[] = [];
  const orfas: number[] = [];
  const porta: PortaRevisita = {
    conhecidas: () => o.falharConhecidas ? Promise.reject(new Error("PostgREST 500")) : Promise.resolve(new Set(o.conhecidas ?? [])),
    consultar: (nIdReceb) => {
      consultas.push(nIdReceb);
      if (o.falharConsulta?.includes(nIdReceb)) return Promise.reject(new Error("OMIE_TRANSIENT"));
      return Promise.resolve(o.detalhes?.[nIdReceb]);
    },
    inserirOrfa: (d) => {
      orfas.push(d.nIdReceb);
      return Promise.resolve();
    },
    linhasDoPedido: (contrato, fornecedor) =>
      Promise.resolve(linhas.filter((l) => l.contrato === contrato && l.fornecedor === fornecedor).map((l) => ({ ...l }))),
    vincularSeSemNF: (id, patch) => {
      const l = linhas.find((x) => x.id === id)!;
      if (l.nfe_chave_acesso) return Promise.resolve(false);
      Object.assign(l, patch);
      return Promise.resolve(true);
    },
  };
  return { porta, consultas, orfas, linhas };
}

const opcoes: Parameters<typeof revisitarJanela>[4] = { agoraIso: () => "2026-10-18T04:15:00Z", temTempo: () => true };
const rodar = (docs: DocumentoRevisita[], b: ReturnType<typeof banco>, ja: number[] = [], op = opcoes) =>
  revisitarJanela(docs, new Set(ja), b.porta, mapear, op, novaRevisitaSummary("18/09/2026→18/10/2026"));

Deno.test("(a) variante 2: NF conhecida vincula a linha que nasceu depois, sem consultar a Omie", async () => {
  const b = banco([
    { id: "p1002", contrato: "2091397", fornecedor: SAYERLACK, nfe_chave_acesso: CHAVE_0935816 },
    { id: "p1003", contrato: "2091399", fornecedor: SAYERLACK, nfe_chave_acesso: null },
  ], { conhecidas: [935816] });
  const r = await rodar([doc(935816, CHAVE_0935816, "0935816", ["2091397", "2091399"])], b);
  assertEquals(b.consultas, [], "conhecida não consulta");
  assertEquals(b.linhas[1].nfe_chave_acesso, CHAVE_0935816, "linha nova ganhou a NF");
  assertEquals(b.linhas[1].nid_receb, 935816, "e o sinal do recebimento junto");
  assertEquals(b.linhas[1].nfe_numero, "0935816");
  assertEquals([r.conhecidas, r.linhas_vinculadas, r.ja_vinculadas, r.consultadas, r.orfas_inseridas], [1, 1, 1, 0, 0]);
});

Deno.test("(b) variante 3: desconhecida consulta; com linha vincula, sem linha vira órfã", async () => {
  const b = banco([{ id: "p1011", contrato: "2093505", fornecedor: SAYERLACK, nfe_chave_acesso: null }], {
    detalhes: {
      936908: bruto(CHAVE_0936908, "000936908", ["2093505"]),
      945865: bruto(CHAVE_OUTRA, "000945865", ["2115479"]),
    },
  });
  const r = await rodar([
    // A listagem não traz pedido: a desconhecida decide pelo DETALHE, como o laço principal.
    doc(936908, CHAVE_0936908, "000936908", []),
    doc(945865, CHAVE_OUTRA, "000945865", [], { emissaoIso: "2026-08-04T00:00:00-03:00" }),
  ], b);
  assertEquals(b.consultas, [936908, 945865]);
  assertEquals(b.linhas[0].nfe_chave_acesso, CHAVE_0936908);
  assertEquals(b.orfas, [945865], "só a sem linha vira órfã");
  assertEquals([r.desconhecidas, r.consultadas, r.linhas_vinculadas, r.orfas_inseridas], [2, 2, 1, 1]);
});

Deno.test("(c) linha com OUTRA NF fica intocada; desconhecida com linha não vira órfã", async () => {
  const b = banco([{ id: "p1010", contrato: "2093144", fornecedor: SAYERLACK, nfe_chave_acesso: CHAVE_OUTRA }], {
    conhecidas: [],
    detalhes: { 936908: bruto(CHAVE_0936908, "000936908", ["2093144"]) },
  });
  const r = await rodar([doc(936908, CHAVE_0936908, "000936908", ["2093144"])], b);
  assertEquals(b.linhas[0].nfe_chave_acesso, CHAVE_OUTRA, "nunca sobrescreve");
  assertEquals([r.conflito_outra_nf, r.linhas_vinculadas, r.orfas_inseridas], [1, 0, 0]);
});

Deno.test("(d) CT-e, cancelada, sem fornecedor, sem chave e já processada no run ficam de fora", async () => {
  const b = banco([{ id: "x", contrato: "1", fornecedor: SAYERLACK, nfe_chave_acesso: null }]);
  const r = await rodar([
    doc(1, CHAVE_0935816, "1", ["1"], { cte: true }),
    doc(2, CHAVE_0935816, "2", ["1"], { cancelada: true }),
    doc(3, CHAVE_0935816, "3", ["1"], { fornecedor: null }),
    doc(4, CHAVE_0935816, "4", ["1"], { chave: null }),
    doc(5, CHAVE_0935816, "5", ["1"]),
    doc(5, CHAVE_0935816, "5", ["1"]), // repetida na listagem
  ], b, [5]);
  assertEquals(b.consultas, []);
  assertEquals(b.linhas[0].nfe_chave_acesso, null);
  assertEquals(
    [r.documentos_listados, r.ctes_ignorados, r.canceladas_puladas, r.puladas_invalidas, r.ja_processadas_no_run],
    [5, 1, 1, 2, 1],
  );
});

Deno.test("(d') cancelada no detalhe não vincula; fornecedor diferente não casa", async () => {
  const b = banco([
    { id: "a", contrato: "2091399", fornecedor: SAYERLACK, nfe_chave_acesso: null },
    { id: "b", contrato: "777", fornecedor: OUTRO_FORN, nfe_chave_acesso: null },
  ], { detalhes: { 9: bruto(CHAVE_0936908, "9", ["2091399"], { cancelada: true }) }, conhecidas: [8] });
  const r = await rodar([doc(9, CHAVE_0936908, "9", []), doc(8, CHAVE_0935816, "8", ["777"])], b);
  assertEquals([b.linhas[0].nfe_chave_acesso, b.linhas[1].nfe_chave_acesso], [null, null]);
  assertEquals([r.canceladas_puladas, r.orfas_inseridas, r.linhas_vinculadas], [1, 0, 0]);
});

Deno.test("(e) a NF mais antiga vence a disputa pela mesma linha, qualquer que seja a ordem da listagem", async () => {
  const b = banco([{ id: "p", contrato: "2098269", fornecedor: SAYERLACK, nfe_chave_acesso: null }], { conhecidas: [10, 11] });
  const r = await rodar([
    doc(11, CHAVE_OUTRA, "nova", ["2098269"], { emissaoIso: "2026-06-20T00:00:00-03:00" }),
    doc(10, CHAVE_0935816, "antiga", ["2098269"], { emissaoIso: "2026-06-10T00:00:00-03:00" }),
  ], b);
  assertEquals(b.linhas[0].nfe_chave_acesso, CHAVE_0935816);
  assertEquals([r.linhas_vinculadas, r.conflito_outra_nf], [1, 1]);
});

Deno.test("(f) consulta que falha não vira órfã; `conhecidas` que falha não revisita nada", async () => {
  const b = banco([], { falharConsulta: [20] });
  const r = await rodar([doc(20, CHAVE_0936908, "20", [])], b);
  assertEquals([b.orfas, r.erros, r.consultadas], [[], 1, 0]);

  const b2 = banco([{ id: "p", contrato: "1", fornecedor: SAYERLACK, nfe_chave_acesso: null }], { falharConhecidas: true });
  const r2 = await rodar([doc(21, CHAVE_0936908, "21", ["1"])], b2);
  assertEquals([b2.consultas, b2.orfas, b2.linhas[0].nfe_chave_acesso, r2.erros], [[], [], null, 1]);
});

Deno.test("(f') detalhe com chave diferente da listagem não vincula nem vira órfã", async () => {
  const b = banco([{ id: "p", contrato: "1", fornecedor: SAYERLACK, nfe_chave_acesso: null }], {
    detalhes: { 30: bruto(CHAVE_OUTRA, "30", ["1"]) },
  });
  const r = await rodar([doc(30, CHAVE_0936908, "30", [])], b);
  assertEquals([b.linhas[0].nfe_chave_acesso, b.orfas, r.erros], [null, [], 1]);
});

Deno.test("(g) sem tempo: conta as puladas e para", async () => {
  const b = banco([], { conhecidas: [40, 41, 42] });
  let n = 0;
  const r = await rodar(
    [doc(40, CHAVE_0935816, "40", ["x"]), doc(41, CHAVE_0935816, "41", ["x"]), doc(42, CHAVE_0935816, "42", ["x"])],
    b, [], { ...opcoes, temTempo: () => n++ < 2 } // 1ª chamada: antes de `conhecidas`; 2ª: a NF 40,
  );
  assertEquals([r.conhecidas, r.puladas_por_tempo, r.interrompido_por_timeout], [1, 2, true]);
});

Deno.test("(g') sem tempo já no início: nem pergunta ao banco quem é conhecida", async () => {
  let perguntou = false;
  const b = banco([]);
  b.porta.conhecidas = () => { perguntou = true; return Promise.resolve(new Set()); };
  const r = await rodar([doc(43, CHAVE_0935816, "43", ["x"])], b, [], { ...opcoes, temTempo: () => false });
  assertEquals([perguntou, r.puladas_por_tempo, r.interrompido_por_timeout], [false, 1, true]);
});

Deno.test("(i) listagem incompleta não escreve nada, mesmo com a linha esperando (Codex P1)", async () => {
  const b = banco([{ id: "p", contrato: "2098269", fornecedor: SAYERLACK, nfe_chave_acesso: null }], {
    detalhes: { 51: bruto(CHAVE_OUTRA, "51", []) },
    conhecidas: [50],
  });
  const r = await rodar(
    [doc(50, CHAVE_0935816, "nova", ["2098269"]), doc(51, CHAVE_OUTRA, "desconhecida", [])],
    b, [], { ...opcoes, listagemIncompleta: true },
  );
  assertEquals([b.linhas[0].nfe_chave_acesso, b.consultas, b.orfas], [null, [], []]);
  assertEquals([r.listagem_incompleta, r.erros, r.documentos_listados], [true, 1, 2]);
});

Deno.test("(h) rodar de novo é no-op", async () => {
  const linhas: LinhaTabela[] = [{ id: "p1003", contrato: "2091399", fornecedor: SAYERLACK, nfe_chave_acesso: null }];
  const docs = [doc(935816, CHAVE_0935816, "0935816", ["2091399"])];
  await rodar(docs, banco(linhas, { conhecidas: [935816] }));
  const r = await rodar(docs, banco(linhas, { conhecidas: [935816] }));
  assertEquals([r.linhas_vinculadas, r.ja_vinculadas], [0, 1]);
});

Deno.test("revisita_dias: só inteiro de 1 a 60; o resto desliga a revisita", () => {
  assertEquals([30, 1, 60].map(lerRevisitaDias), [30, 1, 60]);
  assertEquals([0, 61, -3, 2.5, "30", null, undefined, Number.NaN].map(lerRevisitaDias), [null, null, null, null, null, null, null, null]);
});

Deno.test("janela explícita: dd/mm/aaaa válidas, em ordem, até 120 dias; o resto é null", () => {
  assertEquals(lerJanelaExplicita("01/05/2026", "31/07/2026"), { dataDe: "01/05/2026", dataAte: "31/07/2026" });
  assertEquals(lerJanelaExplicita("08/05/2026", "08/05/2026"), { dataDe: "08/05/2026", dataAte: "08/05/2026" });
  const invalidas: Array<[unknown, unknown]> = [
    ["01/08/2026", "01/05/2026"], // invertida
    ["31/02/2026", "10/03/2026"], // data inexistente
    ["2026-05-01", "31/07/2026"], // formato
    ["01/01/2026", "31/07/2026"], // > 120 dias
    ["01/05/2026", undefined],
    [null, "31/07/2026"],
  ];
  assertEquals(invalidas.map(([a, b]) => lerJanelaExplicita(a, b)), invalidas.map(() => null));
});
