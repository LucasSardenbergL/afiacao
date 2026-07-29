// Testa o CÓDIGO REAL de plano-tools.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/generate-tactical-plan/
//
// Foco: o plano tático guia a abordagem comercial de um cliente real. Número
// projetado sobre dado ausente chega à vendedora com cara de medido, e objetivo
// estratégico inventado muda a estratégia inteira da visita.
import {
  CAMPOS_LTV,
  CAMPOS_RESULTADO,
  normalizarObjecoes,
  normalizarPerguntas,
  normalizarPlano,
  normalizarProjecao,
  normalizarRiscos,
  numeroOuNulo,
  objetivoFinal,
  OBJETIVOS_ESTRATEGICOS,
  planoTemConteudo,
  TOOL_PLANO_ESSENCIAL,
  TOOL_PLANO_ESTRATEGICO,
  toolDoModo,
} from "./plano-tools.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(
      `${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`,
    );
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const PLANO_MINIMO = {
  strategic_objective: "expansao_mix",
  approach_strategy: "Abordagem consultiva focada em mix.",
  diagnostic_questions: [{ question: "q", purpose: "p", expected_insight: "e" }],
  probable_objections: [],
};

// ───────────────────────────── schema da tool ─────────────────────────────

Deno.test("schema: os dois modos usam o MESMO nome de tool (o caller força por nome)", () => {
  assertEquals(TOOL_PLANO_ESSENCIAL.name, TOOL_PLANO_ESTRATEGICO.name);
});

Deno.test("schema: projeções são NULLABLE — obrigar número forçaria fabricação", () => {
  // O prompt manda: "se a margem atual for null, retorne expected_result com
  // null nos três cenários". Um schema que exigisse number contradiria isso.
  const props = TOOL_PLANO_ESTRATEGICO.input_schema.properties as Record<
    string,
    { type?: unknown }
  >;
  assertEquals(props.expected_result.type, ["object", "null"]);
  assertEquals(props.ltv_projection.type, ["object", "null"]);
  const req = TOOL_PLANO_ESTRATEGICO.input_schema.required as string[];
  assert(!req.includes("expected_result"), "expected_result NÃO pode ser required");
  assert(!req.includes("ltv_projection"), "ltv_projection NÃO pode ser required");
});

Deno.test("schema: objetivo estratégico é enum fechado", () => {
  const props = TOOL_PLANO_ESSENCIAL.input_schema.properties as Record<
    string,
    { enum?: string[] }
  >;
  assertEquals(props.strategic_objective.enum, [...OBJETIVOS_ESTRATEGICOS]);
});

Deno.test("toolDoModo: só 'estrategico' pega o schema completo", () => {
  assertEquals(toolDoModo("estrategico"), TOOL_PLANO_ESTRATEGICO);
  for (const m of ["essencial", "", "ESTRATEGICO", "outro"]) {
    assertEquals(toolDoModo(m), TOOL_PLANO_ESSENCIAL, `modo ${JSON.stringify(m)}`);
  }
});

// ─────────────────────────────── numeroOuNulo ───────────────────────────────

Deno.test("numeroOuNulo: ausente/ilegível vira null, NUNCA zero", () => {
  // Number(null) === 0 fabricaria margem zero onde não há medição.
  for (const v of [null, undefined, "", "n/a", NaN, Infinity, {}, [], "12,5"]) {
    assertEquals(numeroOuNulo(v), null, `entrada ${JSON.stringify(v)}`);
  }
});

Deno.test("numeroOuNulo: zero MEDIDO continua valendo zero", () => {
  // Diferente de ausente: 0 informado é um fato.
  assertEquals(numeroOuNulo(0), 0);
  assertEquals(numeroOuNulo("0"), 0);
  assertEquals(numeroOuNulo(-3.5), -3.5);
});

// ───────────────────────────── normalizarProjecao ─────────────────────────────

Deno.test("normalizarProjecao: projeção toda ilegível vira null, não objeto de zeros", () => {
  const r = normalizarProjecao(
    { best_case_margin: null, likely_margin: "n/a", worst_case_margin: undefined },
    CAMPOS_RESULTADO,
  );
  assertEquals(r, null, "sem nenhum campo medido é 'não sei' inteiro");
});

Deno.test("normalizarProjecao: projeção PARCIAL é invalidada inteira (all-or-null)", () => {
  // Não é preciosismo: a UI faz `plan.ltvProjection && …` (checa o OBJETO) e
  // depois `fmt(v) = v.toLocaleString(...)` em cada membro. Um membro null
  // chega em fmt(null) e DERRUBA a tela do plano.
  assertEquals(
    normalizarProjecao({ current_annual: 120000, projected_annual: null, growth_pct: 15 }, CAMPOS_LTV),
    null,
    "1 de 3 ausente invalida",
  );
  assertEquals(
    normalizarProjecao({ current_annual: 120000 }, CAMPOS_LTV),
    null,
    "campos faltando invalidam",
  );
});

Deno.test("normalizarProjecao: projeção COMPLETA passa, coagindo string numérica", () => {
  assertEquals(
    normalizarProjecao({ current_annual: 120000, projected_annual: "138000", growth_pct: 15 }, CAMPOS_LTV),
    { current_annual: 120000, projected_annual: 138000, growth_pct: 15 },
  );
});

Deno.test("normalizarProjecao: não-objeto degrada para null", () => {
  for (const v of [null, undefined, "x", 42, []]) {
    assertEquals(normalizarProjecao(v, CAMPOS_LTV), null, `entrada ${JSON.stringify(v)}`);
  }
});

// ────────────────────────────── normalizarPlano ──────────────────────────────

Deno.test("normalizarPlano: objetivo fora do enum vira null (não vale rótulo inventado)", () => {
  // O caller cai no objetivo derivado server-side, que é medido.
  const p = normalizarPlano({ ...PLANO_MINIMO, strategic_objective: "dominar_o_mercado" });
  assertEquals(p.strategic_objective, null);
});

Deno.test("normalizarPlano: cada objetivo válido do enum é aceito", () => {
  for (const obj of OBJETIVOS_ESTRATEGICOS) {
    const p = normalizarPlano({ ...PLANO_MINIMO, strategic_objective: obj });
    assertEquals(p.strategic_objective, obj, `objetivo ${obj}`);
  }
});

Deno.test("normalizarPlano: campos ausentes viram vazio, não undefined", () => {
  const p = normalizarPlano({});
  assertEquals(p.approach_strategy, "");
  assertEquals(p.diagnostic_questions, []);
  assertEquals(p.probable_objections, []);
  assertEquals(p.operational_risks, []);
  assertEquals(p.ltv_projection, null);
  assertEquals(p.expected_result, null);
});

Deno.test("normalizarPlano: lista que veio como não-array não explode", () => {
  const p = normalizarPlano({ ...PLANO_MINIMO, diagnostic_questions: "três perguntas" });
  assertEquals(p.diagnostic_questions, []);
});

Deno.test("normalizarPlano: margem não medida NÃO vira projeção de zeros", () => {
  const p = normalizarPlano({
    ...PLANO_MINIMO,
    expected_result: { best_case_margin: null, likely_margin: null, worst_case_margin: null },
  });
  assertEquals(p.expected_result, null, "três nulls = não medido, e a UI mostra —");
});

// ────────────────────────────── planoTemConteudo ──────────────────────────────

Deno.test("planoTemConteudo: plano vazio NÃO é gravável", () => {
  // Gravar isto entregaria uma tela preenchida sem orientação nenhuma.
  assertEquals(planoTemConteudo(normalizarPlano({})), false);
  assertEquals(
    planoTemConteudo(normalizarPlano({ approach_strategy: "   ", diagnostic_questions: [] })),
    false,
  );
});

Deno.test("planoTemConteudo: exige abordagem E perguntas — uma só não basta", () => {
  assertEquals(
    planoTemConteudo(normalizarPlano({ approach_strategy: "Focar em mix." })),
    false,
    "abordagem sem perguntas não é plano",
  );
  assertEquals(
    planoTemConteudo(normalizarPlano({ diagnostic_questions: [{ question: "q" }] })),
    false,
    "perguntas sem abordagem não é plano",
  );
  assert(
    planoTemConteudo(
      normalizarPlano({
        approach_strategy: "Focar em mix.",
        diagnostic_questions: [{ question: "q" }],
      }),
    ),
    "os dois juntos valem",
  );
});

Deno.test("planoTemConteudo: modo estratégico exige também B, implicação e transição", () => {
  // A tela do estratégico TEM essas seções; gravar sem elas abre um plano
  // "completo" com metade dos blocos vazios.
  const base = {
    approach_strategy: "A",
    diagnostic_questions: [{ question: "q" }],
  };
  assertEquals(planoTemConteudo(normalizarPlano(base), "estrategico"), false);
  assert(
    planoTemConteudo(
      normalizarPlano({
        ...base,
        approach_strategy_b: "B",
        implication_question: "impacto?",
        offer_transition: "transição",
      }),
      "estrategico",
    ),
    "com todos os campos do estratégico vale",
  );
  assert(planoTemConteudo(normalizarPlano(base), "essencial"), "essencial não exige os extras");
});

// ─────────────────── itens internos das listas (crash de UI) ───────────────────

Deno.test("normalizarPerguntas: objeto VAZIO no array não vira pergunta", () => {
  // `diagnostic_questions: [{}]` passava no guard antigo (length 1) e virava
  // item em branco na tela.
  assertEquals(normalizarPerguntas([{}, { purpose: "p" }]), []);
});

Deno.test("normalizarPerguntas: pergunta válida preserva os 3 campos", () => {
  const r = normalizarPerguntas([{ question: "Como está o ritmo?", purpose: "p", expected_insight: "e" }]);
  assertEquals(r.length, 1);
  assertEquals(r[0], { question: "Como está o ritmo?", purpose: "p", expected_insight: "e" });
});

Deno.test("normalizarObjecoes: sem enunciado é descartada; probabilidade fora de 0-100 vira null", () => {
  const r = normalizarObjecoes([
    {},
    { objection: "Preço alto", probability: 250 },
    { objection: "Prazo", probability: 70 },
  ]);
  assertEquals(r.length, 2);
  assertEquals(r[0].probability, null, "250 não é probabilidade");
  assertEquals(r[1].probability, 70);
});

Deno.test("normalizarRiscos: objeto no array é descartado — derrubaria o React", () => {
  // A UI faz <span>{risk}</span>; um objeto ali lança
  // "Objects are not valid as a React child" e quebra a página inteira.
  assertEquals(normalizarRiscos(["Risco real", {}, "", { a: 1 }, "  ", "Outro"]), [
    "Risco real",
    "Outro",
  ]);
});

Deno.test("normalizarRiscos: entrada não-array degrada para vazio", () => {
  for (const v of [null, undefined, "texto", 42]) {
    assertEquals(normalizarRiscos(v), [], `entrada ${JSON.stringify(v)}`);
  }
});

// ─────────────────────────────── objetivoFinal ───────────────────────────────

Deno.test("objetivoFinal: servidor VENCE quando derivou ativacao (sem_historico é fato)", () => {
  // Cliente sem venda válida registrada. "recuperacao" passa no enum mas
  // pressupõe uma relação que nunca existiu.
  const r = objetivoFinal("recuperacao", "ativacao");
  assertEquals(r.objetivo, "ativacao");
  assertEquals(r.sobrescrito, true, "a divergência tem de ser sinalizada");
});

Deno.test("objetivoFinal: nos demais objetivos a leitura da IA prevalece", () => {
  // São faixas de churn/mix/recência — heurísticas, onde a IA pode ter contexto.
  const r = objetivoFinal("upsell_premium", "expansao_mix");
  assertEquals(r.objetivo, "upsell_premium");
  assertEquals(r.sobrescrito, false);
});

Deno.test("objetivoFinal: IA nula cai no derivado sem marcar sobrescrita", () => {
  assertEquals(objetivoFinal(null, "ativacao"), { objetivo: "ativacao", sobrescrito: false });
  assertEquals(objetivoFinal(null, "expansao_mix"), { objetivo: "expansao_mix", sobrescrito: false });
  assertEquals(objetivoFinal(null, null), { objetivo: null, sobrescrito: false });
});

Deno.test("objetivoFinal: IA concordando com ativacao não conta como sobrescrita", () => {
  assertEquals(objetivoFinal("ativacao", "ativacao"), { objetivo: "ativacao", sobrescrito: false });
});
