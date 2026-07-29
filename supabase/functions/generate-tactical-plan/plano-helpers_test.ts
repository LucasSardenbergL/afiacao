// Testa o CÓDIGO REAL de plano-helpers.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/generate-tactical-plan/
//
// Foco: os guards money-path da saída da IA. O plano tático é lido por uma vendedora
// como análise DAQUELE cliente — número fabricado ali chega como medido. Os dois alvos:
//   1. o FALLBACK FABRICADO (P2 desde 2026-07-04): resposta ilegível virava um plano
//      genérico gravado com status 'gerado';
//   2. `Number(null) === 0`: margem/probabilidade não medida virando 0.
import {
  extrairToolUseUnico,
  montarPlano,
  normalizarCenarios,
  normalizarLtv,
  normalizarObjecoes,
  normalizarPerguntas,
  normalizarRiscos,
  numeroNoIntervalo,
  numeroValido,
  objetivoValido,
  statusDeErroIa,
  textoValido,
  toolDoModo,
} from "./plano-helpers.ts";

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

// ---------------------------------------------------------------------------
// numeroValido — a porta de fabricação
// ---------------------------------------------------------------------------

Deno.test("numeroValido: string vazia NAO vira zero", () => {
  // `Number("") === 0`. Um campo que o modelo deixou em branco viraria margem 0%.
  assertEquals(numeroValido(""), null);
  assertEquals(numeroValido("   "), null);
});

Deno.test("numeroValido: null e undefined NAO viram zero", () => {
  assertEquals(numeroValido(null), null);
  assertEquals(numeroValido(undefined), null);
});

Deno.test("numeroValido: NaN e Infinity viram null", () => {
  assertEquals(numeroValido(NaN), null);
  assertEquals(numeroValido(Infinity), null);
  assertEquals(numeroValido(-Infinity), null);
});

Deno.test("numeroValido: aceita numero e string numerica", () => {
  assertEquals(numeroValido(12.5), 12.5);
  assertEquals(numeroValido("12.5"), 12.5);
  assertEquals(numeroValido(0), 0); // zero AFIRMADO pela IA é dado, não ausência
});

Deno.test("numeroValido: objeto e array viram null", () => {
  assertEquals(numeroValido({}), null);
  assertEquals(numeroValido([]), null); // `Number([]) === 0`
  assertEquals(numeroValido([5]), null); // `Number([5]) === 5`
});

Deno.test("numeroNoIntervalo: fora da faixa vira null, NAO satura na borda", () => {
  assertEquals(numeroNoIntervalo(150, 0, 100), null);
  assertEquals(numeroNoIntervalo(-10, 0, 100), null);
  assertEquals(numeroNoIntervalo(100, 0, 100), 100);
  assertEquals(numeroNoIntervalo(0, 0, 100), 0);
});

Deno.test("textoValido: string em branco vira null", () => {
  assertEquals(textoValido("   "), null);
  assertEquals(textoValido(""), null);
  assertEquals(textoValido("  ok  "), "ok");
  assertEquals(textoValido(42), null);
});

// ---------------------------------------------------------------------------
// objetivo
// ---------------------------------------------------------------------------

Deno.test("objetivoValido: aceita o enum e rejeita texto livre", () => {
  assertEquals(objetivoValido("expansao_mix"), "expansao_mix");
  assertEquals(objetivoValido("EXPANSAO_MIX"), "expansao_mix");
  assertEquals(objetivoValido("vender mais"), null);
  assertEquals(objetivoValido(null), null);
});

// ---------------------------------------------------------------------------
// perguntas e objeções
// ---------------------------------------------------------------------------

Deno.test("normalizarPerguntas: descarta pergunta sem texto e conta o descarte", () => {
  const r = normalizarPerguntas([
    { question: "Como está o ritmo?", purpose: "contexto", expected_insight: "volume" },
    { question: "   ", purpose: "x", expected_insight: "y" },
    { purpose: "sem question" },
  ]);
  assertEquals(r.perguntas.length, 1);
  assertEquals(r.descartadas, 2);
});

Deno.test("normalizarPerguntas: nao-array vira lista vazia", () => {
  assertEquals(normalizarPerguntas(null).perguntas, []);
  assertEquals(normalizarPerguntas("texto").perguntas, []);
});

Deno.test("normalizarObjecoes: probabilidade ausente NAO vira 0", () => {
  // "objeção com 0% de probabilidade" afirma que o cliente não vai levantá-la —
  // afirmação que a IA não fez. O campo tem de sumir, não zerar.
  const r = normalizarObjecoes([
    { objection: "Preço alto", technical_response: "a", economic_response: "b", probability: null },
  ]);
  assertEquals(r.objecoes.length, 1);
  assert(
    !("probability" in r.objecoes[0]),
    `probability deveria estar AUSENTE, veio ${JSON.stringify(r.objecoes[0])}`,
  );
});

Deno.test("normalizarObjecoes: probabilidade fora de 0-100 some", () => {
  const r = normalizarObjecoes([
    { objection: "X", technical_response: "", economic_response: "", probability: 150 },
  ]);
  assert(!("probability" in r.objecoes[0]), "probability 150 deveria ter sido descartada");
});

Deno.test("normalizarObjecoes: probabilidade legitima e preservada", () => {
  const r = normalizarObjecoes([
    { objection: "X", technical_response: "t", economic_response: "e", probability: 70 },
  ]);
  assertEquals(r.objecoes[0].probability, 70);
});

Deno.test("normalizarObjecoes: objecao sem texto e descartada", () => {
  const r = normalizarObjecoes([{ technical_response: "t" }, { objection: "" }]);
  assertEquals(r.objecoes, []);
  assertEquals(r.descartadas, 2);
});

// ---------------------------------------------------------------------------
// cenários de margem e LTV — o núcleo money-path
// ---------------------------------------------------------------------------

Deno.test("normalizarCenarios: margem nao medida fica null, NUNCA 0", () => {
  const r = normalizarCenarios({
    best_case_margin: null,
    likely_margin: 18.5,
    worst_case_margin: "",
  });
  assertEquals(r, { best_case_margin: null, likely_margin: 18.5, worst_case_margin: null });
});

Deno.test("normalizarCenarios: os tres ausentes viram bloco null", () => {
  // Três traços na tela é ruído; a ausência do bloco diz o mesmo sem simular projeção.
  assertEquals(
    normalizarCenarios({ best_case_margin: null, likely_margin: null, worst_case_margin: null }),
    null,
  );
  assertEquals(normalizarCenarios(null), null);
  assertEquals(normalizarCenarios("nao medido"), null);
});

Deno.test("normalizarLtv: campo ilegivel vira null e nao contamina os outros", () => {
  assertEquals(normalizarLtv({ current_annual: 120000, projected_annual: "n/a", growth_pct: null }), {
    current_annual: 120000,
    projected_annual: null,
    growth_pct: null,
  });
});

Deno.test("normalizarLtv: tudo ausente vira bloco null", () => {
  assertEquals(normalizarLtv({ current_annual: "", projected_annual: null, growth_pct: undefined }), null);
});

Deno.test("normalizarRiscos: mantem so strings com conteudo", () => {
  assertEquals(normalizarRiscos(["prazo apertado", "", null, 42, "  estoque  "]), [
    "prazo apertado",
    "estoque",
  ]);
  assertEquals(normalizarRiscos("nao é array"), []);
});

// ---------------------------------------------------------------------------
// montarPlano — o fallback fabricado
// ---------------------------------------------------------------------------

Deno.test("montarPlano: resposta vazia FALHA em vez de fabricar plano generico", () => {
  // A regressão que este teste tranca: a versão do gateway montava
  // { approach_strategy: 'Abordagem consultiva padrão.', diagnostic_questions: [3 fixas] }
  // e gravava com status 'gerado'.
  const r = montarPlano({}, "estrategico", "expansao_mix");
  assertEquals(r.ok, false);
  if (r.ok) throw new Error("deveria ter falhado");
  assertEquals(r.motivo, "plano_vazio");
});

Deno.test("montarPlano: so lixo tambem FALHA", () => {
  const r = montarPlano(
    { approach_strategy: "   ", diagnostic_questions: [{ purpose: "sem pergunta" }] },
    "estrategico",
    "reativacao",
  );
  assertEquals(r.ok, false);
});

Deno.test("montarPlano: abordagem sem perguntas ainda e plano valido", () => {
  const r = montarPlano({ approach_strategy: "Abrir pelo custo por peça afiada." }, "essencial", "ativacao");
  assertEquals(r.ok, true);
});

Deno.test("montarPlano: perguntas sem abordagem ainda e plano valido", () => {
  const r = montarPlano(
    { diagnostic_questions: [{ question: "Qual o volume mensal?" }] },
    "essencial",
    "ativacao",
  );
  assertEquals(r.ok, true);
});

Deno.test("montarPlano: objetivo invalido cai no do SERVIDOR e avisa", () => {
  const r = montarPlano(
    { strategic_objective: "vender mais", approach_strategy: "abordagem" },
    "essencial",
    "consolidacao_margem",
  );
  if (!r.ok) throw new Error("deveria ter montado");
  assertEquals(r.plano.strategic_objective, "consolidacao_margem");
  assert(r.avisos.length > 0, "deveria ter avisado sobre o objetivo inválido");
});

Deno.test("montarPlano: objetivo da IA prevalece quando valido", () => {
  const r = montarPlano(
    { strategic_objective: "upsell_premium", approach_strategy: "abordagem" },
    "essencial",
    "expansao_mix",
  );
  if (!r.ok) throw new Error("deveria ter montado");
  assertEquals(r.plano.strategic_objective, "upsell_premium");
  assertEquals(r.avisos, []);
});

Deno.test("montarPlano: margem nao medida chega ao plano como null, nunca 0", () => {
  const r = montarPlano(
    {
      approach_strategy: "abordagem",
      expected_result: { best_case_margin: null, likely_margin: null, worst_case_margin: null },
      ltv_projection: { current_annual: null, projected_annual: null, growth_pct: null },
    },
    "estrategico",
    "expansao_mix",
  );
  if (!r.ok) throw new Error("deveria ter montado");
  assertEquals(r.plano.expected_result, null);
  assertEquals(r.plano.ltv_projection, null);
});

Deno.test("montarPlano: modo essencial nao carrega campos do estrategico", () => {
  const r = montarPlano(
    {
      approach_strategy: "abordagem",
      approach_strategy_b: "plano B",
      ltv_projection: { current_annual: 1000 },
      expected_result: { likely_margin: 20 },
      operational_risks: ["risco"],
    },
    "essencial",
    "expansao_mix",
  );
  if (!r.ok) throw new Error("deveria ter montado");
  assertEquals(r.plano.approach_strategy_b, null);
  assertEquals(r.plano.ltv_projection, null);
  assertEquals(r.plano.expected_result, null);
  assertEquals(r.plano.operational_risks, []);
});

Deno.test("montarPlano: modo estrategico preserva os campos completos", () => {
  const r = montarPlano(
    {
      strategic_objective: "expansao_mix",
      approach_strategy: "abordagem",
      approach_strategy_b: "plano B",
      implication_question: "quanto custa a parada?",
      offer_transition: "com base nisso...",
      ltv_projection: { current_annual: 1000, projected_annual: 1500, growth_pct: 50 },
      expected_result: { best_case_margin: 30, likely_margin: 22, worst_case_margin: 15 },
      operational_risks: ["prazo"],
    },
    "estrategico",
    "expansao_mix",
  );
  if (!r.ok) throw new Error("deveria ter montado");
  assertEquals(r.plano.approach_strategy_b, "plano B");
  assertEquals(r.plano.implication_question, "quanto custa a parada?");
  assertEquals(r.plano.ltv_projection?.growth_pct, 50);
  assertEquals(r.plano.expected_result?.likely_margin, 22);
  assertEquals(r.plano.operational_risks, ["prazo"]);
});

// ---------------------------------------------------------------------------
// extração do tool_use
// ---------------------------------------------------------------------------

Deno.test("extrairToolUseUnico: um bloco devolve o input", () => {
  const r = extrairToolUseUnico([{ type: "tool_use", input: { approach_strategy: "x" } }]);
  assertEquals(r.ok, true);
  if (!r.ok) return;
  assertEquals(r.input, { approach_strategy: "x" });
});

Deno.test("extrairToolUseUnico: zero blocos = ausente, com o texto para o log", () => {
  const r = extrairToolUseUnico([{ type: "text", text: "não consigo analisar" }]);
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertEquals(r.motivo, "ausente");
  assert(r.texto.includes("não consigo"), "deveria capturar o texto do modelo");
});

Deno.test("extrairToolUseUnico: DOIS blocos = multiplo, nao consome o primeiro", () => {
  // P1 do /codex no #1608: consumir só o primeiro entrega plano PARCIAL como completo.
  const r = extrairToolUseUnico([
    { type: "tool_use", input: { a: 1 } },
    { type: "tool_use", input: { b: 2 } },
  ]);
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertEquals(r.motivo, "multiplo");
  assertEquals(r.quantidade, 2);
});

Deno.test("extrairToolUseUnico: content nao-array nao explode", () => {
  assertEquals(extrairToolUseUnico(null).ok, false);
  assertEquals(extrairToolUseUnico(undefined).ok, false);
});

// ---------------------------------------------------------------------------
// erro da API
// ---------------------------------------------------------------------------

Deno.test("statusDeErroIa: 402 continua sendo 402 (a falha que motivou a migracao)", () => {
  // Se 402 caísse no genérico, o batch registraria http_500 e ninguém saberia que o
  // problema é saldo — exatamente o que aconteceu com o gateway Lovable.
  assertEquals(statusDeErroIa(402)?.http, 402);
  assertEquals(statusDeErroIa(429)?.http, 429);
  assertEquals(statusDeErroIa(500)?.http, 503);
  assertEquals(statusDeErroIa(529)?.http, 503);
});

Deno.test("statusDeErroIa: status desconhecido ou ausente devolve null", () => {
  assertEquals(statusDeErroIa(418), null);
  assertEquals(statusDeErroIa(undefined), null);
});

// ---------------------------------------------------------------------------
// contrato com o modelo
// ---------------------------------------------------------------------------

Deno.test("toolDoModo: os dois modos usam o MESMO nome de tool", () => {
  // O index.ts passa `tool.name` em tool_choice; nomes divergentes fariam o forced
  // tool-use apontar para uma tool inexistente.
  assertEquals(toolDoModo("essencial").name, toolDoModo("estrategico").name);
});

Deno.test("toolDoModo: estrategico expoe os campos que o essencial nao tem", () => {
  const props = toolDoModo("estrategico").input_schema.properties as Record<string, unknown>;
  for (const campo of ["approach_strategy_b", "implication_question", "ltv_projection", "expected_result"]) {
    assert(campo in props, `tool estratégica deveria expor ${campo}`);
  }
  const essencial = toolDoModo("essencial").input_schema.properties as Record<string, unknown>;
  assert(!("ltv_projection" in essencial), "tool essencial não deveria expor ltv_projection");
});

Deno.test("tool: margem e probabilidade aceitam null no schema", () => {
  // Sem `null` no tipo, o modelo é forçado a inventar um número para dizer "não medi".
  const props = toolDoModo("estrategico").input_schema.properties as Record<
    string,
    { properties?: Record<string, { type?: unknown }> }
  >;
  const cenarios = props.expected_result.properties!;
  for (const campo of ["best_case_margin", "likely_margin", "worst_case_margin"]) {
    assertEquals(cenarios[campo].type, ["number", "null"], `${campo} precisa aceitar null`);
  }
});
