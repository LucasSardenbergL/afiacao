import {
  convDaOrigem, convPendentePorSku, quantidadesEmUnidadeOmie, recusaPorUnidade, saldoEmUnidadeOmie,
} from "./unidade-omie.ts";
import { criarColetorObservacao, observacaoBateComPendente, somarContribuicaoPorSku } from "./observacao-po.ts";

function igual<T>(real: T, esperado: T, msg: string): void {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a !== b) throw new Error(`${msg}\n  real:     ${a}\n  esperado: ${b}`);
}

// Grupo WP como na prod (2026-10-09): QT fator 1 / 0,81 L · GL fator 4 / 3,24 L. PostgREST devolve numeric como número.
const QT = "8689791246", GL = "8689791300";
const wp = (u1: unknown = 0.81, u4: unknown = 3.24) => [
  { grupo_id: "g-wp01", sku_codigo_omie: Number(QT), fator_para_base: 1, unidades_omie_por_embalagem: u1 },
  { grupo_id: "g-wp01", sku_codigo_omie: Number(GL), fator_para_base: 4, unidades_omie_por_embalagem: u4 },
];

Deno.test("grupo WP coerente: cada membro converte pela própria u", () => {
  const r = convPendentePorSku(wp());
  igual([...r.conv.entries()], [[QT, 0.81], [GL, 3.24]], "conv = u");
  igual(r.problemas, [], "sem problema");
});

Deno.test("2 GL fora da janela = 6,48 L; 5 QT (PO 1268) = 4,05 L", () => {
  igual(saldoEmUnidadeOmie(2, 3.24), 6.48, "2 GL");
  igual(saldoEmUnidadeOmie(5, 0.81), 4.05, "5 QT");
  igual(quantidadesEmUnidadeOmie(6, 1, 0.81), { qtde: 4.05, recebido: 0 }, "saldo 5 QT com recebido 1");
  igual(quantidadesEmUnidadeOmie(1, 3, 0.81), { qtde: 0, recebido: 0 }, "recebido acima: saldo 0, nunca negativo");
});

Deno.test("CONTROLE: sem conv o número é o MESMO (byte a byte) — grupo sem cadastro, parcial, incoerente, sem grupo", () => {
  const semCadastro = convPendentePorSku(wp(null, null));
  const parcial = convPendentePorSku(wp(0.81, null));
  const incoerente = convPendentePorSku(wp(0.81, 3.6));
  const zero = convPendentePorSku(wp(0, 0));
  const gigante = convPendentePorSku(wp(1e9, 4e9));
  for (const [nome, r] of [["sem", semCadastro], ["parcial", parcial], ["incoerente", incoerente], ["zero", zero], ["1e9", gigante]] as const) {
    igual(r.conv.size, 0, `${nome}: nenhum SKU convertido`);
    igual(r.problemas, [], `${nome}: não é problema (o motor volta ao fator)`);
  }
  for (const v of [0, 1, 0.1 + 0.2, 7.123456789, 1e-12]) {
    igual(Object.is(saldoEmUnidadeOmie(v, undefined), v), true, `saldo ${v} intocado`);
    const q = quantidadesEmUnidadeOmie(v + 3, 3, undefined);
    igual([Object.is(q.qtde, v + 3), q.recebido], [true, 3], `par (${v + 3}, 3) intocado`);
  }
});

Deno.test("grupo de UM membro com u válida também converte (o motor não exige 2 no conv)", () => {
  const r = convPendentePorSku([wp()[0]]);
  igual([...r.conv.entries()], [[QT, 0.81]], "conv do único membro");
});

Deno.test("coerência EXATA como o numeric do motor: 3,240000001 no GL é incoerente (fallback, cru)", () => {
  igual(convPendentePorSku(wp(0.81, 3.240000001)).conv.size, 0, "diferença ínfima = incoerente, como no SQL");
  igual(convPendentePorSku(wp("0.81", "3.2400")).conv.size, 2, "zeros à direita não mudam o valor");
  igual(convPendentePorSku(wp(0.81, 0.1 + 0.2)).problemas.length, 1, "double com > 15 dígitos: ilegível, não palpite");
});

Deno.test("razão igual em decimal mas não em double (0,3/3 vs 0,1/1) ainda é coerente", () => {
  const r = convPendentePorSku([
    { grupo_id: "g", sku_codigo_omie: 1, fator_para_base: 1, unidades_omie_por_embalagem: 0.1 },
    { grupo_id: "g", sku_codigo_omie: 2, fator_para_base: 3, unidades_omie_por_embalagem: 0.3 },
  ]);
  igual(r.conv.size, 2, "tolerância relativa");
});

Deno.test("grupos não se misturam; numeric em string também é lido", () => {
  const r = convPendentePorSku([
    ...wp("0.81", "3.24"),
    { grupo_id: "outro", sku_codigo_omie: 77, fator_para_base: 1, unidades_omie_por_embalagem: null },
    { grupo_id: "outro", sku_codigo_omie: 78, fator_para_base: 4, unidades_omie_por_embalagem: null },
  ]);
  igual([...r.conv.keys()], [QT, GL], "só o grupo WP");
});

Deno.test("fail-closed: valor ilegível é PROBLEMA, não 'sem cadastro'", () => {
  igual(convPendentePorSku(wp("0,81", 3.24)).problemas.length, 1, "vírgula decimal");
  igual(convPendentePorSku(wp(Number.NaN, 3.24)).problemas.length, 1, "NaN");
  igual(convPendentePorSku(wp(0.81, {})).problemas.length, 1, "objeto");
  igual(convPendentePorSku([{ grupo_id: "g", sku_codigo_omie: "", fator_para_base: 1, unidades_omie_por_embalagem: 0.81 }])
    .problemas.length, 1, "sem sku");
});

Deno.test("a contribuição da observação e o pendente fecham na mesma unidade (2ª testemunha)", () => {
  const { conv } = convPendentePorSku(wp());
  const parse = {
    parseQtd: (v: unknown) => (typeof v === "number" ? v : NaN),
    parseRecebido: (v: unknown) => (v === undefined ? 0 : typeof v === "number" ? v : NaN),
  };
  const col = criarColetorObservacao((s) => s === QT || s === GL, parse);
  col.registrar({ nCodPed: 1268, cNumero: "1268", cEtapa: "15" }, [
    { nCodItem: 1, nCodProd: Number(QT), nQtde: 5 },
    { nCodItem: 2, nCodProd: Number(GL), nQtde: 3, nQtdeRec: 1 },
  ], null, convDaOrigem("AFI-1268", conv));
  igual(col.linhas.map((l) => [l.quantidade, l.quantidade_recebida, l.contribuicao]), [[5, 0, 4.05], [3, 1, 6.48]],
    "quantidade do PO crua, contribuição em litros");
  const pendente = new Map([[QT, quantidadesEmUnidadeOmie(5, 0, conv.get(QT)).qtde], [GL, quantidadesEmUnidadeOmie(3, 1, conv.get(GL)).qtde]]);
  igual(observacaoBateComPendente(col.linhas, pendente), true, "bate");
  igual(observacaoBateComPendente(col.linhas, new Map([[QT, 5], [GL, 2]])), false, "o pendente CRU não bate mais");
  igual([...somarContribuicaoPorSku(col.linhas).entries()], [[QT, 4.05], [GL, 6.48]], "soma por SKU");
});

Deno.test("recusa: leitura que falhou ou linha ilegível barra o pendente; leitura limpa (mesmo sem WP) não", () => {
  igual(recusaPorUnidade(null, "timeout")?.startsWith("unidade do PO não lida"), true, "leitura falhou");
  igual(recusaPorUnidade(convPendentePorSku(wp("0,81", 3.24)), null)?.startsWith("unidade do PO ilegível"), true, "ilegível");
  igual(recusaPorUnidade(convPendentePorSku(wp()), null), null, "WP legível");
  igual(recusaPorUnidade(convPendentePorSku([]), null), null, "nenhum grupo cadastrado: nada a converter, publica cru");
});

Deno.test("origem: PO do app (AFI-) converte; PO manual (litros) e carimbo de outra integração ficam crus", () => {
  const { conv } = convPendentePorSku(wp());
  igual(convDaOrigem("AFI-990001", conv)(GL), 3.24, "app");
  igual(convDaOrigem("  AFI-7 ", conv)(QT), 0.81, "app com espaço");
  igual(convDaOrigem("", conv)(GL), undefined, "manual sem carimbo");
  igual(convDaOrigem("afi-7", conv)(GL), undefined, "caixa diferente não é o carimbo");
  igual(convDaOrigem("ERP-123", conv)(QT), undefined, "outra integração");
  igual(convDaOrigem("AFI-1", conv)("999"), undefined, "app, SKU fora dos grupos");
});
