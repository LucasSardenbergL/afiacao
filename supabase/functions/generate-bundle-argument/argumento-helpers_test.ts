// Provas do bloco de contexto que vai ao modelo. O invariante é um só: dado que ninguém
// mediu chega como "não medido", nunca como número (docs/agent/money-path.md §2).
//
// O caso que motivou o arquivo: `Gasto médio mensal: R$ ${customer.avgMonthlySpend || 0}`
// imprimia "R$ 0" para cliente sem o dado — e o modelo concluía "cliente pequeno, sensível a
// preço", mudando a abordagem comercial que a vendedora leva para a rua.

// Sem import remoto: `test:edges` roda com `--no-remote` e um `https://deno.land/std/...`
// colocaria o jsr/deno.land no caminho de entrega de TODO PR (CLAUDE.md). Asserts locais são
// o padrão do repo — ver _shared/escrita-critica_test.ts e _shared/lease_test.ts.
import {
  blocoCliente,
  campoNumerico,
  NAO_MEDIDO,
  REGRA_DADO_AUSENTE,
  valorMedido,
} from "./argumento-helpers.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

function assertStringIncludes(texto: string, esperado: string, msg?: string) {
  if (!texto.includes(esperado)) {
    throw new Error(msg ?? `esperava encontrar ${JSON.stringify(esperado)} em:\n${texto}`);
  }
}

// ── valorMedido: o tri-estado ──────────────────────────────────────────────────

Deno.test("valorMedido: ausência em todas as suas formas vira null", () => {
  // `[]` e `[0]` estão aqui porque `Number([]) === 0` e `Number([0]) === 0`: um payload
  // malformado atravessaria um guard escrito como `Number(x)` + `isFinite` como um zero de
  // aparência perfeita. Este caso REPROVOU a primeira versão do helper — a allowlist por
  // `typeof` entrou por causa dele, não por precaução teórica.
  for (const ausente of [null, undefined, "", "   ", NaN, Infinity, -Infinity, "abc", {}, [], [0], true, false]) {
    assertEquals(valorMedido(ausente), null, `${JSON.stringify(ausente)} deveria ser null`);
  }
});

Deno.test("valorMedido: ZERO é medido, não ausente", () => {
  // A metade que se esquece. `0` é um fato apurado ("não gastou nada"), e confundi-lo com
  // ausência é o mesmo erro na direção oposta.
  assertEquals(valorMedido(0), 0);
  assertEquals(valorMedido("0"), 0);
  assertEquals(valorMedido(1234.5), 1234.5);
  assertEquals(valorMedido("12.5"), 12.5); // JSON às vezes traz número como string
});

// ── campoNumerico: a renderização ──────────────────────────────────────────────

Deno.test("campoNumerico: ausente não ganha prefixo de moeda", () => {
  // "R$ não medido" seria pior que a ausência — parece um valor formatado.
  assertEquals(campoNumerico(null, { prefixo: "R$ " }), NAO_MEDIDO);
  assertEquals(campoNumerico(undefined, { sufixo: "/100" }), NAO_MEDIDO);
});

Deno.test("campoNumerico: medido conserva prefixo e sufixo", () => {
  assertEquals(campoNumerico(1500, { prefixo: "R$ " }), "R$ 1500");
  assertEquals(campoNumerico(0, { prefixo: "R$ " }), "R$ 0"); // zero medido continua "R$ 0"
  assertEquals(campoNumerico(72, { sufixo: "/100" }), "72/100");
});

// ── blocoCliente: o prompt real ────────────────────────────────────────────────

Deno.test("blocoCliente: gasto ausente NÃO vira R$ 0 (o bug que originou o módulo)", () => {
  const bloco = blocoCliente({ name: "Marcenaria Alfa", healthScore: 40 });

  assertStringIncludes(bloco, `Gasto médio mensal: ${NAO_MEDIDO}`);
  // O assert que tem dente: a string fabricada não pode aparecer em lugar NENHUM do bloco.
  assertEquals(
    bloco.includes("R$ 0"),
    false,
    `bloco fabricou um gasto de R$ 0:\n${bloco}`,
  );
});

Deno.test("blocoCliente: categorias ausentes NÃO viram 0", () => {
  const bloco = blocoCliente({ name: "Marcenaria Alfa", healthScore: 40 });
  assertStringIncludes(bloco, `Categorias compradas: ${NAO_MEDIDO}`);
  assertEquals(bloco.includes("Categorias compradas: 0"), false, bloco);
});

Deno.test("blocoCliente: gasto MEDIDO continua chegando como número", () => {
  // O par obrigatório do teste acima: sem ele, um helper que devolvesse "não medido" para
  // TUDO passaria — e teria destruído o contexto em vez de corrigi-lo.
  const bloco = blocoCliente({
    name: "Alfa",
    healthScore: 80,
    avgMonthlySpend: 3200,
    categoryCount: 6,
    daysSinceLastPurchase: 12,
  });
  assertStringIncludes(bloco, "Gasto médio mensal: R$ 3200");
  assertStringIncludes(bloco, "Categorias compradas: 6");
  assertStringIncludes(bloco, "Health Score: 80/100");
  // Com TODO campo numérico medido, o rótulo de ausência não pode aparecer em nenhum deles.
  assertEquals(bloco.includes(NAO_MEDIDO), false, bloco);
});

Deno.test("blocoCliente: gasto ZERO medido é preservado como R$ 0", () => {
  // Precisão nos dois sentidos: cliente que de fato não gastou nada não pode virar "não medido".
  const bloco = blocoCliente({ name: "Alfa", healthScore: 10, avgMonthlySpend: 0, categoryCount: 0 });
  assertStringIncludes(bloco, "Gasto médio mensal: R$ 0");
  assertStringIncludes(bloco, "Categorias compradas: 0");
});

Deno.test("blocoCliente: 0 dias desde a última compra é FATO, não ausência", () => {
  // O `|| 'N/A'` anterior engolia o cliente que comprou HOJE — mesma confusão, sentido inverso.
  const bloco = blocoCliente({ name: "Alfa", healthScore: 90, daysSinceLastPurchase: 0 });
  assertStringIncludes(bloco, "Dias desde última compra: 0");
  assertEquals(bloco.includes(`Dias desde última compra: ${NAO_MEDIDO}`), false, bloco);
});

Deno.test("blocoCliente: string vazia não vira número zero", () => {
  // `Number("") === 0` é a porta de fabricação mais silenciosa da família.
  const bloco = blocoCliente({ name: "Alfa", healthScore: 50, avgMonthlySpend: "", categoryCount: "  " });
  assertStringIncludes(bloco, `Gasto médio mensal: ${NAO_MEDIDO}`);
  assertStringIncludes(bloco, `Categorias compradas: ${NAO_MEDIDO}`);
});

Deno.test("blocoCliente: histórico vazio não inventa produtos", () => {
  const semNada = blocoCliente({ name: "Alfa", healthScore: 50 });
  assertStringIncludes(semNada, "Histórico de compras recentes: Sem dados");

  const comProdutos = blocoCliente({ name: "Alfa", healthScore: 50, recentProducts: ["Serra", "Fresa"] });
  assertStringIncludes(comProdutos, "Histórico de compras recentes: Serra, Fresa");
});

// ── o contrato com o modelo ────────────────────────────────────────────────────

Deno.test("REGRA_DADO_AUSENTE acompanha o rótulo que o bloco realmente emite", () => {
  // Se o rótulo mudar e a instrução não, o modelo recebe uma palavra sem contrato e preenche
  // a lacuna sozinho — a fabricação só teria mudado de camada.
  assertStringIncludes(REGRA_DADO_AUSENTE, NAO_MEDIDO);
  assertStringIncludes(REGRA_DADO_AUSENTE, "NÃO MEDIDO");
  // O erro específico a impedir: ausência de gasto lida como cliente sensível a preço.
  assertStringIncludes(REGRA_DADO_AUSENTE, "sensível a preço");
});
