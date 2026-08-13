// Testa o CÓDIGO REAL de plano-helpers.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/generate-tactical-plan/
//
// Foco: os guards money-path da saída da IA. O plano tático é lido por uma vendedora
// como análise DAQUELE cliente — número fabricado ali chega como medido. Os dois alvos:
//   1. o FALLBACK FABRICADO (P2 desde 2026-07-04): resposta ilegível virava um plano
//      genérico gravado com status 'gerado';
//   2. `Number(null) === 0`: margem/probabilidade não medida virando 0.
import {
  ehJaNaFilaDaRpc,
  ehSkipLegitimoDaRpc,
  extrairToolUseUnico,
  montarPlano,
  normalizarCenarios,
  normalizarLtv,
  normalizarObjecoes,
  normalizarPerguntas,
  normalizarRiscos,
  numeroNoIntervalo,
  numerosDoBundle,
  numeroValido,
  objetivoFinal,
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

/** Mínimo que passa o gate de suficiência — abordagem E ao menos uma pergunta. */
const SUFICIENTE = {
  approach_strategy: "Abrir pelo custo por peça afiada.",
  diagnostic_questions: [{ question: "Qual o volume mensal?", purpose: "p", expected_insight: "e" }],
};

Deno.test("montarPlano: abordagem SEM perguntas nao e plano suficiente", () => {
  // "Seja consultiva" + zero diagnóstico é o fallback fabricado com outro texto.
  const r = montarPlano({ approach_strategy: "Seja consultiva" }, "essencial", "ativacao");
  assertEquals(r.ok, false);
  if (r.ok) return;
  assert(r.detalhe.includes("perguntas"), `detalhe deveria citar o que faltou: ${r.detalhe}`);
});

Deno.test("montarPlano: perguntas SEM abordagem nao e plano suficiente", () => {
  const r = montarPlano(
    { diagnostic_questions: [{ question: "Qual o volume mensal?" }] },
    "essencial",
    "ativacao",
  );
  assertEquals(r.ok, false);
  if (r.ok) return;
  assert(r.detalhe.includes("abordagem"), `detalhe deveria citar o que faltou: ${r.detalhe}`);
});

Deno.test("montarPlano: abordagem + pergunta passa o gate", () => {
  assertEquals(montarPlano(SUFICIENTE, "essencial", "ativacao").ok, true);
});

Deno.test("montarPlano: objetivo do SERVIDOR prevalece sobre o da IA", () => {
  // `selectObjective` é regra determinística e alimenta badge/scoring. Deixar a IA
  // sobrescrever criava divergência silenciosa entre a tela e a regra.
  const r = montarPlano(
    { ...SUFICIENTE, strategic_objective: "recuperacao" },
    "essencial",
    "ativacao",
  );
  if (!r.ok) throw new Error("deveria ter montado");
  assertEquals(r.plano.strategic_objective, "ativacao");
  assert(r.avisos.some((a) => a.includes("diverge")), "deveria avisar a divergência");
});

Deno.test("montarPlano: sem divergencia nao ha aviso", () => {
  const r = montarPlano(
    { ...SUFICIENTE, strategic_objective: "ativacao" },
    "essencial",
    "ativacao",
  );
  if (!r.ok) throw new Error("deveria ter montado");
  assertEquals(r.avisos, []);
});

Deno.test("montarPlano: objetivo do servidor invalido cai no da IA e avisa", () => {
  const r = montarPlano(
    { ...SUFICIENTE, strategic_objective: "upsell_premium" },
    "essencial",
    "lixo_que_nao_e_enum",
  );
  if (!r.ok) throw new Error("deveria ter montado");
  assertEquals(r.plano.strategic_objective, "upsell_premium");
  assert(r.avisos.length > 0, "deveria ter avisado");
});

Deno.test("montarPlano: margem nao medida chega ao plano como null, nunca 0", () => {
  const r = montarPlano(
    {
      ...SUFICIENTE,
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
      ...SUFICIENTE,
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
      ...SUFICIENTE,
      strategic_objective: "expansao_mix",
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
// skip legítimo × erro real da RPC
// ---------------------------------------------------------------------------

Deno.test("ehSkipLegitimoDaRpc: race de reatribuicao e skip", () => {
  // Mensagens reais da RPC em produção (conferidas com pg_get_functiondef).
  assert(
    ehSkipLegitimoDaRpc(
      "Carteira do cliente 123 foi reatribuída durante a geração (dono atual diverge do esperado)",
    ),
    "race de posse deveria ser skip",
  );
  assert(ehSkipLegitimoDaRpc("Cliente 123 sem dono de carteira"), "sem dono deveria ser skip");
  assert(
    ehSkipLegitimoDaRpc("Cliente 123 está mascarado na carteira (eligible) — plano tático não é materializado"),
    "mascarado deveria ser skip",
  );
});

Deno.test("ehSkipLegitimoDaRpc: falha de INFRA NAO e skip", () => {
  // Este é o ponto: tratar tudo como skip devolvia ok:true num lote sem nenhum plano.
  assert(!ehSkipLegitimoDaRpc("canceling statement due to statement timeout"), "timeout é erro");
  assert(!ehSkipLegitimoDaRpc('invalid input syntax for type numeric: ""'), "cast é erro");
  assert(!ehSkipLegitimoDaRpc("could not serialize access due to concurrent update"), "serialização é erro");
  assert(!ehSkipLegitimoDaRpc("Não autenticado"), "auth é erro");
  assert(!ehSkipLegitimoDaRpc(""), "vazio é erro");
  assert(!ehSkipLegitimoDaRpc(undefined), "ausente é erro");
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

// ─────────────────────────────── objetivoFinal ───────────────────────────────
// O enum barra objetivo INVENTADO; estes testes cobrem o objetivo VÁLIDO e ERRADO,
// que é o que faz estrago — passa em `objetivoValido` e venceria o fato medido.

Deno.test("objetivoFinal: com sem_historico, o SERVIDOR vence a IA", () => {
  // `sem_historico → ativacao` é fato binário (não há venda válida no resumo).
  // "recuperacao" pressupõe uma relação que nunca existiu.
  const r = objetivoFinal("recuperacao", "ativacao");
  assertEquals(r.objetivo, "ativacao");
  assertEquals(r.sobrescrito, true, "a divergência precisa ser sinalizada p/ log");
});

Deno.test("objetivoFinal: qualquer objetivo != ativacao é descartado sob sem_historico", () => {
  for (const daIa of ["reativacao", "expansao_mix", "upsell_premium", "consolidacao_margem"]) {
    const r = objetivoFinal(daIa as never, "ativacao");
    assertEquals(r.objetivo, "ativacao", `IA disse ${daIa}`);
    assertEquals(r.sobrescrito, true, `IA disse ${daIa}`);
  }
});

Deno.test("objetivoFinal: nos demais derivados a leitura da IA prevalece", () => {
  // Ali o derivado sai de FAIXAS (churn/mix/recência) — o corte numérico é
  // grosseiro e a IA pode ter contexto melhor.
  const r = objetivoFinal("upsell_premium", "expansao_mix");
  assertEquals(r.objetivo, "upsell_premium");
  assertEquals(r.sobrescrito, false);
});

Deno.test("objetivoFinal: IA nula cai no derivado, sem marcar sobrescrita", () => {
  assertEquals(objetivoFinal(null, "ativacao"), { objetivo: "ativacao", sobrescrito: false });
  assertEquals(objetivoFinal(null, "recuperacao"), { objetivo: "recuperacao", sobrescrito: false });
  assertEquals(objetivoFinal(null, null), { objetivo: null, sobrescrito: false });
});

Deno.test("objetivoFinal: IA concordando com ativacao não é sobrescrita", () => {
  assertEquals(objetivoFinal("ativacao", "ativacao"), { objetivo: "ativacao", sobrescrito: false });
});

// ---------------------------------------------------------------------------
// numerosDoBundle — a segunda porta de fabricação, do lado do PAYLOAD
// ---------------------------------------------------------------------------
//
// Os normalizadores acima cuidam do que a IA devolve. Estes quatro campos vêm de
// OUTRA fonte (farmer_bundle_recommendations) e escapavam por um `Number(... ?? 0)`
// no index.ts. Medido em prod 2026-07-31: 339/339 planos com bundle_lie,
// bundle_probability e bundle_incremental_margin = 0, e NENHUM com
// bundle_recommendation_id — ou seja, 100% dos zeros são "não havia bundle" gravado
// como se fosse medição, e o card exibe "LIE R$ 0,00" para toda a base.

Deno.test("numerosDoBundle: SEM bundle os quatro campos sao null, nunca 0", () => {
  // "não há bundle" ≠ "o bundle vale R$ 0,00". O segundo é um veredito comercial
  // (não vale a pena vender) que ninguém mediu.
  assertEquals(numerosDoBundle(null), {
    bundle_lie: null,
    bundle_probability: null,
    bundle_incremental_margin: null,
    best_individual_lie: null,
  });
  assertEquals(numerosDoBundle(undefined), {
    bundle_lie: null,
    bundle_probability: null,
    bundle_incremental_margin: null,
    best_individual_lie: null,
  });
});

Deno.test("numerosDoBundle: bundle COM campo nulo degrada so aquele campo", () => {
  // As três colunas de farmer_bundle_recommendations são nullable (e ainda têm
  // `column_default 0`): p_bundle/m_bundle ausentes não podem contaminar o lie medido.
  assertEquals(numerosDoBundle({ lie_bundle: 1250.5, p_bundle: null, m_bundle: null }), {
    bundle_lie: 1250.5,
    bundle_probability: null,
    bundle_incremental_margin: null,
    best_individual_lie: null,
  });
});

Deno.test("numerosDoBundle: aceita numeric como string (PostgREST) e preserva o zero MEDIDO", () => {
  // numeric do Postgres chega como string no supabase-js. E `0` vindo da coluna é
  // veredito apurado — degradá-lo para null seria o erro simétrico.
  assertEquals(numerosDoBundle({ lie_bundle: "0", p_bundle: "12.5", m_bundle: "-3" }), {
    bundle_lie: 0,
    bundle_probability: 12.5,
    bundle_incremental_margin: -3,
    best_individual_lie: null,
  });
});

Deno.test("numerosDoBundle: best_individual_lie e SEMPRE null (ninguem o calcula)", () => {
  // Era `0` hardcoded nos dois writers. Nenhum código do repo computa este número;
  // gravar 0 afirma "nenhum item individual vale a pena" sobre uma conta que não existe.
  const cheio = numerosDoBundle({ lie_bundle: 10, p_bundle: 20, m_bundle: 30, best_individual_lie: 99 });
  assertEquals(cheio.best_individual_lie, null);
});

// ---------------------------------------------------------------------------
// ehJaNaFilaDaRpc — o skip de idempotência vindo do banco
// ---------------------------------------------------------------------------

// VERBATIM da mensagem que `criar_plano_tatico` levanta — mantida igual à da migration
// 20260808_tactical_plan_idempotencia_janela.sql. Se a migration mudar o texto, este
// teste é o que trava: sem o casamento, a recusa vira `http_500` no relatório do lote.
const MSG_RPC_JA_NA_FILA =
  "Já existe plano tático aberto na fila para este cliente (janela de 7 dias)";

// A mensagem da fase 1, que a RPC ainda levanta ENQUANTO a migration da fase 2 não for
// aplicada. O deploy não é atômico (migration pelo SQL Editor, edge pelo chat do Lovable),
// então as duas convivem durante a janela — ver PADROES_JA_NA_FILA.
const MSG_RPC_FASE1 =
  "Já existe plano tático gerado hoje para este cliente (dia operacional BRT)";

Deno.test("ehJaNaFilaDaRpc: reconhece a recusa da RPC por plano ja aberto na fila", () => {
  // Casado por trecho ASCII (sem acento) pelo mesmo motivo de PADROES_SKIP_RPC — mas a
  // mensagem ACENTUADA de produção é a que precisa passar, então é ela que o assert usa.
  assert(ehJaNaFilaDaRpc(MSG_RPC_JA_NA_FILA), "deveria reconhecer a recusa por plano na fila");
  assert(
    ehJaNaFilaDaRpc("Ja existe plano tatico aberto na fila para este cliente (janela de 7 dias)"),
    "a variante sem acento tambem tem de casar (normalizacao unicode do driver)",
  );
});

Deno.test("ehJaNaFilaDaRpc: ainda reconhece a mensagem da fase 1 (deploy nao-atomico)", () => {
  // Entre o deploy da edge e o apply da migration, a RPC em prod ainda fala a mensagem
  // antiga. Sem este casamento a trava voltaria como http_500 e o lote a contaria como
  // ERRO — um falso alarme de quebra justamente durante a janela de deploy.
  assert(ehJaNaFilaDaRpc(MSG_RPC_FASE1), "a mensagem da fase 1 tem de continuar casando");
});

Deno.test("ehJaNaFilaDaRpc: NAO confunde com os outros skips nem com erro real", () => {
  // Discriminador: se casar largo demais, um erro de infra vira "pulei de propósito"
  // e o lote reporta ok:true sem ter gravado (a classe do incidente de 2026-07-21).
  assertEquals(ehJaNaFilaDaRpc("Cliente x sem dono de carteira"), false);
  assertEquals(ehJaNaFilaDaRpc("canceling statement due to statement timeout"), false);
  assertEquals(ehJaNaFilaDaRpc(null), false);
  assertEquals(ehJaNaFilaDaRpc(undefined), false);
});

Deno.test("ehJaNaFilaDaRpc: a trava da fila NAO entra no skip de race de posse", () => {
  // Os dois são `skipped`, mas com motivos DIFERENTES no relatório do lote
  // (`ja_na_fila` vs `rpc_race`) — misturá-los apaga a distinção entre
  // "a trava funcionou" e "a carteira mudou no meio".
  assertEquals(ehSkipLegitimoDaRpc(MSG_RPC_JA_NA_FILA), false);
  assertEquals(ehSkipLegitimoDaRpc(MSG_RPC_FASE1), false);
});
