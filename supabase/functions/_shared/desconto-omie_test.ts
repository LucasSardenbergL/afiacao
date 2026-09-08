// deno test supabase/functions/_shared/desconto-omie_test.ts
//
// ⚠️ O PONTO DESTA SUÍTE: o acervo de produção é desconto = 0 em 100% das linhas (70.889 itens
// jsonb + 70.860 order_items, medido 2026-09-07). Onde o desconto é zero, `qtd·preço·(1−d/100)`
// e `qtd·preço − d` dão o MESMO número — as duas semânticas que brigavam em produção coincidem,
// e um teste construído sobre esse acervo passa sem distinguir nada. Por isso todo caso abaixo
// que decide semântica usa desconto ≠ 0, e vários fixam o número que SÓ uma das regras produz.
//
// A âncora é qtd=2, preço=100, desconto=10 → percentual daria 180, absoluto daria 190.

import { descontoItemOmie, precoUnitarioLiquido, receitaLiquidaItem } from "./desconto-omie.ts";

// `eq` local em vez de std/assert remoto: `test:edges` roda com `--no-remote`, e o flag não se
// afrouxa por conveniência de teste (CLAUDE.md).
//
// ⚠️ NÃO é o `eq` do omie-pedido_test.ts vizinho, e a diferença foi MEDIDA, não estilística:
// aquele compara por `JSON.stringify`, que serializa `Infinity`, `-Infinity` e `NaN` todos como
// a string "null" — indistinguíveis de `null` de verdade. A mutação "quantidade zero passa a
// dividir" (scripts/mutcheck.d/desconto-omie.mut) SOBREVIVEU por causa disso: o helper devolvia
// `-Infinity` e o assert que exigia `null` passava feliz. Um instrumento cego no ponto exato que
// esta suíte existe para vigiar. `rotular` mantém os não-finitos visíveis.
function rotular(v: unknown): string {
  if (typeof v === "number" && !Number.isFinite(v)) return `<não-finito:${String(v)}>`;
  return JSON.stringify(v) ?? "<undefined>";
}
function eq(a: unknown, b: unknown, msg: string) {
  if (rotular(a) !== rotular(b)) throw new Error(`${msg}: ${rotular(a)} !== ${rotular(b)}`);
}

Deno.test("DISCRIMINANTE: o mesmo 10, com tipo diferente, dá desconto diferente", () => {
  // Este é o caso que o acervo atual não consegue produzir e que nenhuma das duas fórmulas
  // antigas acertava sozinha: o Omie manda valor E percentual, e `tipo_desconto` decide.
  const bruto = 200; // qtd 2 × preço 100
  eq(descontoItemOmie({ tipo_desconto: "V", valor_desconto: 10 }, bruto), 10, "V: 10 são R$ 10");
  eq(descontoItemOmie({ tipo_desconto: "P", percentual_desconto: 10 }, bruto), 20, "P: 10 são 10% = R$ 20");
  // Se o discriminador fosse ignorado, os dois dariam o mesmo número. Dão diferente:
  const v = descontoItemOmie({ tipo_desconto: "V", valor_desconto: 10 }, bruto);
  const p = descontoItemOmie({ tipo_desconto: "P", percentual_desconto: 10 }, bruto);
  eq(v === p, false, "o tipo MUDA o resultado — o discriminador é lido de verdade");
});

Deno.test("DISCRIMINANTE: desconto grande é legítimo — a régua é a BASE, não o número 100", () => {
  // Casos exigidos pela revisão do Codex. Sob a regra antiga (percentual), "desconto > 100" era
  // inválido — `auditoria-margem.ts` trata 150 como lixo. Em valor absoluto, R$ 150 sobre uma
  // base de R$ 200 é um desconto comum, e 100% é item grátis. Trocar a unidade sem trocar a
  // régua de validade rejeitaria venda boa.
  const bruto = 200; // qtd 2 × preço 100
  eq(descontoItemOmie({ tipo_desconto: "V", valor_desconto: 150 }, bruto), 150, "R$ 150 de 200 é válido");
  eq(receitaLiquidaItem(100, 2, 150), 50, "receita 50");
  eq(descontoItemOmie({ tipo_desconto: "P", percentual_desconto: 100 }, bruto), 200, "100% = a base inteira");
  eq(receitaLiquidaItem(100, 2, 200), 0, "item grátis: receita 0, não negativa");
});

Deno.test("preço unitário líquido divide o desconto pela quantidade", () => {
  // Armadilha apontada na revisão: os consumidores que auditam MARGEM trabalham com preço
  // UNITÁRIO. Subtrair o desconto da linha inteira de cada unidade multiplica o desconto pela
  // quantidade — com qtd 2 e desconto 10, o preço unitário cairia 10 em vez de 5.
  eq(precoUnitarioLiquido(100, 2, 10), 95, "R$ 10 na linha = R$ 5 por unidade");
  eq(precoUnitarioLiquido(100, 2, 10) === 90, false, "NÃO subtrai o desconto inteiro de cada unidade");
  eq(precoUnitarioLiquido(100, 1, 10), 90, "qtd 1: linha e unidade coincidem");
  eq(precoUnitarioLiquido(null, 2, 10), null, "preço ausente não vira zero");
  eq(precoUnitarioLiquido(100, 0, 10), null, "quantidade zero não divide");
});

Deno.test("REGRESSÃO do bug de origem: a chave `desconto` não existe na API e é ignorada", () => {
  // `omie-vendas-sync` lia `prod.desconto`. A doc oficial (2026-09-07) não tem esse campo em
  // `det.produto` — ele é sempre undefined, e o `|| 0` gravava 0. Se alguém reintroduzir a chave
  // achando que ela vale, este assert quebra: um campo que a origem não envia não vira desconto.
  // deno-lint-ignore no-explicit-any
  const comChaveMorta = { desconto: 10 } as any;
  eq(descontoItemOmie(comChaveMorta, 200), 0, "chave inexistente na API não produz desconto");
});

Deno.test("ausência é 0, mas leitura ambígua é null (nunca 0)", () => {
  eq(descontoItemOmie({}, 200), 0, "o Omie não informou desconto = não há desconto");
  eq(descontoItemOmie(null, 200), 0, "produto ausente");
  eq(descontoItemOmie({ tipo_desconto: "V", valor_desconto: 0 }, 200), 0, "informou zero explícito");
  // Fail-closed: cada um destes produziria um número plausível-porém-inventado se degradasse a 0.
  eq(descontoItemOmie({ tipo_desconto: "X", valor_desconto: 10 }, 200), null, "discriminador fora do vocabulário");
  eq(descontoItemOmie({ tipo_desconto: "P", percentual_desconto: 150 }, 200), null, "percentual > 100");
  eq(descontoItemOmie({ tipo_desconto: "V", valor_desconto: 250 }, 200), null, "desconto maior que a base");
  eq(descontoItemOmie({ tipo_desconto: "P", percentual_desconto: 10 }, null), null, "percentual sem base de incidência");
  eq(descontoItemOmie({ tipo_desconto: "V", valor_desconto: -5 }, 200), null, "negativo é lixo, não dado");
  eq(descontoItemOmie({ tipo_desconto: "V", valor_desconto: "abc" }, 200), null, "não-numérico");
});

Deno.test("sem discriminador: um campo só decide; dois só se CONCORDAREM", () => {
  eq(descontoItemOmie({ valor_desconto: 30 }, 200), 30, "só valor");
  eq(descontoItemOmie({ percentual_desconto: 25 }, 200), 50, "só percentual, sobre a base");
  // 25% de 200 = 50 → concordam.
  eq(descontoItemOmie({ valor_desconto: 50, percentual_desconto: 25 }, 200), 50, "concordam");
  // 25% de 200 = 50 ≠ 10 → não dá para escolher, e escolher errado é dinheiro errado.
  eq(descontoItemOmie({ valor_desconto: 10, percentual_desconto: 25 }, 200), null, "discordam → null");
});

Deno.test("tipo aceita variação de caixa/espaço, como texto vindo de API costuma vir", () => {
  eq(descontoItemOmie({ tipo_desconto: "v", valor_desconto: 10 }, 200), 10, "minúsculo");
  eq(descontoItemOmie({ tipo_desconto: " P ", percentual_desconto: 10 }, 200), 20, "com espaços");
});

Deno.test("percentual arredonda a 2 casas (centavo é a menor unidade que existe)", () => {
  eq(descontoItemOmie({ tipo_desconto: "P", percentual_desconto: 33.333 }, 100), 33.33, "33,333% de 100");
});

Deno.test("DISCRIMINANTE: receitaLiquidaItem SUBTRAI o desconto, não multiplica por (1−d/100)", () => {
  // A âncora do defeito. 2 × 100 − 10 = 190. A fórmula percentual daria 180.
  eq(receitaLiquidaItem(100, 2, 10), 190, "absoluto: 190");
  eq(receitaLiquidaItem(100, 2, 10) === 180, false, "NÃO é a fórmula percentual");
  eq(receitaLiquidaItem(100, 2, 0), 200, "sem desconto");
  eq(receitaLiquidaItem(100, 2, null), 200, "desconto ausente conta como zero desconto");
});

Deno.test("receitaLiquidaItem degrada para null quando o preço é desconhecido", () => {
  // `Number(null) === 0` viraria "receita zero com custo cheio" = margem negativa fabricada.
  eq(receitaLiquidaItem(null, 2, 10), null, "preço ausente");
  eq(receitaLiquidaItem(undefined, 2, 10), null, "preço undefined");
  eq(receitaLiquidaItem(100, null, 10), null, "quantidade ausente");
  eq(receitaLiquidaItem(0, 2, 0), 0, "preço zero informado É dado (bonificação), não ausência");
});
