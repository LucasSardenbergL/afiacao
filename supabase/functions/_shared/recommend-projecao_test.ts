// Testa o CÓDIGO REAL da projeção da edge `recommend` (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/recommend-projecao_test.ts
import {
  type CandidatoProjetavel,
  limiteCandidatos,
  projetarCandidato,
  projetarMeta,
  textoExplicacaoMargem,
} from "./recommend-projecao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── Sentinelas ──────────────────────────────────────────────────────────────────────────────
// Valores ESCOLHIDOS para serem improváveis e mutuamente distintos, de modo que procurá-los na
// serialização não dê falso-positivo nem falso-negativo por coincidência aritmética.
const CUSTO = 7.77;
const PRECO = 100;
const MARGEM = PRECO - CUSTO; // 92.23
const PROB = 0.5;
const EIP = PROB * MARGEM; //  46.115
const EILTV = 61.4321;
const CUSTO_RANKING = 8.88;
const SCORE = 0.4242;

function candidato(over: Partial<CandidatoProjetavel> = {}): CandidatoProjetavel {
  return {
    product_id: "p-1",
    codigo: "SKU-1",
    descricao: "Lixa 220",
    price: PRECO,
    margin: MARGEM,
    probability: PROB,
    eip: EIP,
    eiltv: EILTV,
    score_final: SCORE,
    recommendation_type: "cross_sell",
    explanation_text: "Lixa 220 tem alto potencial de margem",
    explanation_key: "margin",
    estoque: 12,
    cost_final: CUSTO,
    cost_source: "PRODUCT_COST",
    cost_confidence: 0.9,
    cost_ranking: CUSTO_RANKING,
    assoc_score: 0.31,
    sim_score: 0.22,
    ctx_score: 0.13,
    penalties: 0.05,
    familia: "abrasivos",
    ...over,
  };
}

// ── O assert que pega o campo que eu esqueci ────────────────────────────────────────────────
// Um teste campo-a-campo só prova o que eu lembrei de listar. Este serializa a projeção inteira e
// exige que NENHUM número derivado de custo apareça em lugar nenhum — pega chave nova, campo
// renomeado, valor embutido em string e objeto aninhado, sem eu precisar prever o formato.
//
// ⚠️ A fixture usa `explanation_text` SUJO de propósito (achado do Codex contra a 1a versão deste
// teste): com o texto já sanitizado, o assert passava sem nunca exercer a alegação de que captura
// número embutido em string — provava o mundo que eu queria ter.
Deno.test("sem capability: nenhum número derivado de custo sobrevive à serialização", () => {
  const sujo = candidato({ explanation_text: `Custo interno R$ ${CUSTO} e margem R$ ${MARGEM}` });
  const json = JSON.stringify(projetarCandidato(sujo, false));
  for (const proibido of [CUSTO, MARGEM, EIP, EILTV, CUSTO_RANKING, SCORE]) {
    assert(
      !json.includes(String(proibido)),
      `vazou ${proibido} na resposta sem cap_custo_ler: ${json}`,
    );
  }
});

Deno.test("sem capability: R$ em texto LIVRE do produtor tambem e removido", () => {
  const sujo = candidato({ explanation_text: "Custo interno R$ 7.77" });
  const out = projetarCandidato(sujo, false) as Record<string, string>;
  assert(!out.explanation_text.includes("7.77"), `vazou: ${out.explanation_text}`);
  assert(out.explanation_text.includes("Custo interno"), "sanitizou demais — perdeu o texto");
});

Deno.test("COM capability: o texto do produtor passa intacto", () => {
  const sujo = candidato({ explanation_text: "Custo interno R$ 7.77" });
  const out = projetarCandidato(sujo, true) as Record<string, string>;
  assertEquals(out.explanation_text, "Custo interno R$ 7.77");
});

Deno.test("sem capability: _admin some INTEIRO (não nulificado campo a campo)", () => {
  const out = projetarCandidato(candidato(), false);
  assert(!("_admin" in out), "_admin presente sem cap_custo_ler");
  assert(!("score_final" in out), "score_final top-level sem cap_custo_ler — insumo da inversão");
});

Deno.test("sem capability: margin/eip PRESENTES e null (degradação honesta, não ausência de chave)", () => {
  const out = projetarCandidato(candidato(), false);
  assert("margin" in out && out.margin === null, "margin deveria estar presente e null");
  assert("eip" in out && out.eip === null, "eip deveria estar presente e null");
});

Deno.test("sem capability: o conteúdo de venda SOBREVIVE (não é apagar a tela)", () => {
  const out = projetarCandidato(candidato(), false);
  assertEquals(out.price, PRECO, "price é legítimo e conhecido pelo cliente");
  assertEquals(out.probability, PROB);
  assertEquals(out.estoque, 12);
  assertEquals(out.descricao, "Lixa 220");
  assertEquals(out.explanation_key, "margin");
  assertEquals(out.recommendation_type, "cross_sell");
});

Deno.test("COM capability: _admin volta e score_final mora DENTRO dele", () => {
  const out = projetarCandidato(candidato(), true) as Record<string, Record<string, unknown>>;
  assert(!("score_final" in out), "score_final deveria ter migrado para dentro de _admin");
  assertEquals(out._admin.score_final, SCORE);
  assertEquals(out._admin.cost_final, CUSTO);
  assertEquals(out._admin.estimated_cost_for_ranking, CUSTO_RANKING);
  assertEquals(out.margin, MARGEM);
  assertEquals(out.eip, EIP);
});

Deno.test("COM capability e custo não confiável: eip/eiltv viram null (money não se fabrica)", () => {
  const out = projetarCandidato(candidato({ margin: null }), true) as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(out.margin, null);
  assertEquals(out.eip, null, "EIP é R$ — sem margem confiável não há lucro a afirmar");
  assertEquals(out._admin.eiltv, null);
});

// ── Explicação: o R$ que ia embutido na PROSA ───────────────────────────────────────────────
Deno.test("explicação sem capability: mantém o sinal, perde o número", () => {
  const txt = textoExplicacaoMargem("Lixa 220", MARGEM, false);
  assert(!txt.includes("R$"), `o R$ sobreviveu na prosa: ${txt}`);
  assert(!txt.includes("92"), `o valor sobreviveu na prosa: ${txt}`);
  assert(txt.includes("alto potencial de margem"), "o sinal de venda foi destruído junto");
});

Deno.test("explicação com capability: o número volta", () => {
  const txt = textoExplicacaoMargem("Lixa 220", MARGEM, true);
  assert(txt.includes("R$ 92.23"), `esperava o valor formatado, veio: ${txt}`);
});

// ── Meta ────────────────────────────────────────────────────────────────────────────────────
Deno.test("meta: weights só com capability (é insumo da inversão de score_final)", () => {
  const pesos = { wA: 0.25, wP: 0.35, wS: 0.2, wC: 0.2 };
  const sem = projetarMeta(50, "profit", pesos, 5, false);
  assert(!("weights" in sem), "weights vazou sem cap_custo_ler");
  assertEquals(sem.total_candidates, 50, "o resto do meta continua");

  const com = projetarMeta(50, "profit", pesos, 20, true);
  assertEquals(com.weights, pesos);
});

// ── Limite de candidatos ────────────────────────────────────────────────────────────────────
Deno.test("limite: vendedora recebe top_n_vendedor, admin recebe top_n_admin", () => {
  assertEquals(limiteCandidatos(5, 20, false), 5, "config já dizia 5 e o código devolvia 20");
  assertEquals(limiteCandidatos(5, 20, true), 20);
});
