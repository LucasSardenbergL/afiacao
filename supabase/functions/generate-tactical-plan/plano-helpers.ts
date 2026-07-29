// Lógica PURA do plano tático: schemas de tool, prompts e sanitização da saída da IA.
// Puro de propósito — `test:edges` roda com `--no-remote` e não resolve `npm:`/`jsr:`,
// então tudo que precisa de teste mora aqui e o index.ts só orquestra.
//
// Contexto: migração do gateway Lovable/Gemini para a Anthropic direta (fase 3 de 4).
// O gateway tem teto próprio de créditos ("AI features usage limit", 4/mês) que, ao
// estourar em 2026-07-27, derrubou as 7 edges que ele serve — o batch noturno de planos
// táticos (59 chamadas/dia) parou por completo.
//
// MONEY-PATH — este módulo existe sobretudo para um invariante:
// o plano tático é lido por uma vendedora como análise DAQUELE cliente. Campo que a IA
// não mediu tem de chegar como "não medido", nunca como número. `Number(null) === 0` e
// `?? 0` são as portas de fabricação — nenhuma delas aparece aqui de propósito.

/** Modelo canônico do repo para código novo (CLAUDE.md §Convenções). */
export const MODELO = "claude-sonnet-4-6";
/** Teto de saída. Plano estratégico completo cabe folgado; truncar é tratado como erro. */
export const MAX_TOKENS = 4000;

/**
 * Objetivos estratégicos aceitos. Espelha o enum de `_shared/tactical-margem.ts`
 * (selectObjective) e `src/lib/scoring/objective.ts` — mudou lá, mude aqui.
 */
export const OBJETIVOS_VALIDOS = [
  "ativacao",
  "recuperacao",
  "expansao_mix",
  "upsell_premium",
  "reativacao",
  "consolidacao_margem",
] as const;

export type Objetivo = (typeof OBJETIVOS_VALIDOS)[number];
export type Modo = "essencial" | "estrategico";

export interface PerguntaDiagnostica {
  question: string;
  purpose: string;
  expected_insight: string;
}

export interface Objecao {
  objection: string;
  technical_response: string;
  economic_response: string;
  /** Ausente quando a IA não deu um percentual legível. NUNCA 0 por omissão. */
  probability?: number;
}

export interface Cenarios {
  best_case_margin: number | null;
  likely_margin: number | null;
  worst_case_margin: number | null;
}

export interface Ltv {
  current_annual: number | null;
  projected_annual: number | null;
  growth_pct: number | null;
}

export interface Plano {
  strategic_objective: Objetivo;
  approach_strategy: string | null;
  approach_strategy_b: string | null;
  diagnostic_questions: PerguntaDiagnostica[];
  implication_question: string | null;
  offer_transition: string | null;
  probable_objections: Objecao[];
  ltv_projection: Ltv | null;
  expected_result: Cenarios | null;
  operational_risks: string[];
}

export type ResultadoMontagem =
  | { ok: true; plano: Plano; avisos: string[] }
  | { ok: false; motivo: "plano_vazio"; detalhe: string };

// ---------------------------------------------------------------------------
// Normalizadores — a fronteira onde "não sei" para de virar número
// ---------------------------------------------------------------------------

/** Texto não-vazio, aparado. Qualquer outra coisa (inclusive "   ") vira null. */
export function textoValido(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Número FINITO ou null. Aceita string numérica (o modelo às vezes devolve "12.5"),
 * mas rejeita "", null, undefined, NaN e Infinity.
 *
 * A rejeição de "" é o ponto: `Number("") === 0`, então um campo que o modelo deixou
 * em branco viraria margem 0% — um número medido, aos olhos de quem lê.
 */
export function numeroValido(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.length === 0) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Número válido DENTRO de [min, max]; fora da faixa → null (não satura na borda). */
export function numeroNoIntervalo(v: unknown, min: number, max: number): number | null {
  const n = numeroValido(v);
  if (n === null) return null;
  return n >= min && n <= max ? n : null;
}

/** Objetivo dentro do enum, ou null. Não tenta "corrigir" texto livre do modelo. */
export function objetivoValido(v: unknown): Objetivo | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return (OBJETIVOS_VALIDOS as readonly string[]).includes(t) ? (t as Objetivo) : null;
}

/**
 * Perguntas diagnósticas. Uma pergunta sem `question` não é pergunta — é descartada.
 * `purpose`/`expected_insight` ausentes viram "" (são acessórios na UI, não afirmam dado).
 */
export function normalizarPerguntas(v: unknown): { perguntas: PerguntaDiagnostica[]; descartadas: number } {
  if (!Array.isArray(v)) return { perguntas: [], descartadas: 0 };
  const perguntas: PerguntaDiagnostica[] = [];
  let descartadas = 0;
  for (const bruto of v) {
    const cru = (bruto ?? {}) as Record<string, unknown>;
    const question = textoValido(cru.question);
    if (!question) {
      descartadas++;
      continue;
    }
    perguntas.push({
      question,
      purpose: textoValido(cru.purpose) ?? "",
      expected_insight: textoValido(cru.expected_insight) ?? "",
    });
  }
  return { perguntas, descartadas };
}

/**
 * Objeções prováveis. `probability` fora de [0,100] ou ilegível → o campo é REMOVIDO,
 * não zerado: "objeção com 0% de probabilidade" é uma afirmação (o cliente não vai
 * levantar isso) que a IA não fez. A objeção em si é preservada.
 */
export function normalizarObjecoes(v: unknown): { objecoes: Objecao[]; descartadas: number } {
  if (!Array.isArray(v)) return { objecoes: [], descartadas: 0 };
  const objecoes: Objecao[] = [];
  let descartadas = 0;
  for (const bruto of v) {
    const cru = (bruto ?? {}) as Record<string, unknown>;
    const objection = textoValido(cru.objection);
    if (!objection) {
      descartadas++;
      continue;
    }
    const probability = numeroNoIntervalo(cru.probability, 0, 100);
    const obj: Objecao = {
      objection,
      technical_response: textoValido(cru.technical_response) ?? "",
      economic_response: textoValido(cru.economic_response) ?? "",
    };
    if (probability !== null) obj.probability = probability;
    objecoes.push(obj);
  }
  return { objecoes, descartadas };
}

/**
 * Cenários de margem. Cada campo é número medido ou null.
 * Se os TRÊS forem null, o objeto inteiro vira null — um card de cenários com três
 * traços é ruído; a ausência do bloco diz a mesma coisa sem simular uma projeção.
 */
export function normalizarCenarios(v: unknown): Cenarios | null {
  if (v === null || typeof v !== "object") return null;
  const cru = v as Record<string, unknown>;
  const cenarios: Cenarios = {
    best_case_margin: numeroValido(cru.best_case_margin),
    likely_margin: numeroValido(cru.likely_margin),
    worst_case_margin: numeroValido(cru.worst_case_margin),
  };
  const algum = cenarios.best_case_margin !== null ||
    cenarios.likely_margin !== null ||
    cenarios.worst_case_margin !== null;
  return algum ? cenarios : null;
}

/** Projeção de LTV. Mesma regra dos cenários: tudo null → bloco null. */
export function normalizarLtv(v: unknown): Ltv | null {
  if (v === null || typeof v !== "object") return null;
  const cru = v as Record<string, unknown>;
  const ltv: Ltv = {
    current_annual: numeroValido(cru.current_annual),
    projected_annual: numeroValido(cru.projected_annual),
    growth_pct: numeroValido(cru.growth_pct),
  };
  const algum = ltv.current_annual !== null ||
    ltv.projected_annual !== null ||
    ltv.growth_pct !== null;
  return algum ? ltv : null;
}

/** Riscos operacionais: strings não-vazias. */
export function normalizarRiscos(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(textoValido).filter((s): s is string => s !== null);
}

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

/**
 * Converte o `input` cru da tool no plano gravável.
 *
 * SUBSTITUI O FALLBACK FABRICADO (P2 aberto desde 2026-07-04,
 * `docs/historico/revisao-completa-2026-07-04.md:71`): a versão anterior, ao falhar o
 * `JSON.parse` da resposta em texto livre, montava um plano genérico — "Abordagem
 * consultiva padrão" e três perguntas fixas sobre ritmo de produção — e o gravava via
 * `criar_plano_tatico` com `status='gerado'`, indistinguível de um plano real. A
 * vendedora abria a ligação com um roteiro que ninguém escreveu para aquele cliente.
 *
 * Agora: conteúdo insuficiente é ERRO (`ok:false`), e a edge devolve 422 sem gravar.
 * O batch noturno já classifica e reporta o motivo por alvo — falhar alto é barato,
 * fabricar é caro.
 *
 * `objetivoServidor` vem de `selectObjective` (regra determinística sobre os scores).
 * Ele é o único campo com fallback legítimo: não é chute, é o valor que o servidor já
 * calculou e que o prompt pediu à IA para confirmar.
 */
export function montarPlano(
  bruto: unknown,
  modo: Modo,
  objetivoServidor: string,
): ResultadoMontagem {
  const cru = (bruto ?? {}) as Record<string, unknown>;
  const avisos: string[] = [];

  const objetivoIa = objetivoValido(cru.strategic_objective);
  const objetivoFallback = objetivoValido(objetivoServidor) ?? "expansao_mix";
  if (!objetivoIa) {
    avisos.push(
      `strategic_objective ausente/inválido (${JSON.stringify(cru.strategic_objective)}) — usando o objetivo calculado pelo servidor: ${objetivoFallback}`,
    );
  }

  const { perguntas, descartadas: perguntasDescartadas } = normalizarPerguntas(cru.diagnostic_questions);
  if (perguntasDescartadas > 0) {
    avisos.push(`${perguntasDescartadas} pergunta(s) diagnóstica(s) sem texto — descartada(s)`);
  }

  const { objecoes, descartadas: objecoesDescartadas } = normalizarObjecoes(cru.probable_objections);
  if (objecoesDescartadas > 0) {
    avisos.push(`${objecoesDescartadas} objeção(ões) sem texto — descartada(s)`);
  }

  const approach = textoValido(cru.approach_strategy);

  // Gate de suficiência: sem abordagem E sem nenhuma pergunta, não há plano — há um
  // formulário vazio. Gravar isso como 'gerado' é o que o fallback antigo fazia.
  if (!approach && perguntas.length === 0) {
    return {
      ok: false,
      motivo: "plano_vazio",
      detalhe: "a IA não devolveu abordagem nem nenhuma pergunta diagnóstica legível",
    };
  }

  const estrategico = modo === "estrategico";

  return {
    ok: true,
    avisos,
    plano: {
      strategic_objective: objetivoIa ?? objetivoFallback,
      approach_strategy: approach,
      approach_strategy_b: estrategico ? textoValido(cru.approach_strategy_b) : null,
      diagnostic_questions: perguntas,
      implication_question: textoValido(cru.implication_question),
      offer_transition: textoValido(cru.offer_transition),
      probable_objections: objecoes,
      ltv_projection: estrategico ? normalizarLtv(cru.ltv_projection) : null,
      expected_result: estrategico ? normalizarCenarios(cru.expected_result) : null,
      operational_risks: estrategico ? normalizarRiscos(cru.operational_risks) : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Contrato com o modelo
// ---------------------------------------------------------------------------

const REGRA_DADO_AUSENTE =
  `DADO AUSENTE: campo com valor null no contexto (ex.: "grossMarginPct": null, "clusterAvgMargin": null)
significa NÃO MEDIDO — não é zero nem valor baixo. NUNCA estime, preencha ou infira um número para ele,
e não construa argumento sobre margem a partir dele. Se um campo numérico da sua resposta dependeria de
um dado não medido, responda null nele em vez de um número plausível. Um número inventado que chega à
vendedora como medido é pior do que a ausência do campo.`;

const REGRA_SEM_HISTORICO =
  `Se "salesHistoryStatus" for "sem_historico" (SEM venda válida registrada — pode nunca ter comprado OU
ter só pedidos cancelados/devolvidos), o objetivo é "ativacao": trate como abertura, NÃO assuma relação
prévia, NÃO trate health/churn como recuperação e NÃO afirme "primeira compra" como fato.`;

export const SYSTEM_ESSENCIAL =
  `Você é um estrategista comercial especializado em afiação de ferramentas industriais.
Gere um Plano Tático ESSENCIAL (rápido) para o vendedor (Farmer), personalizado com os dados reais do cliente.

${REGRA_SEM_HISTORICO}

${REGRA_DADO_AUSENTE}

Use SEMPRE a tool registrar_plano_tatico. Não responda em texto fora dela.`;

export const SYSTEM_ESTRATEGICO =
  `Você é um estrategista comercial sênior especializado em afiação de ferramentas industriais.
Gere um Plano Tático ESTRATÉGICO COMPLETO para o vendedor (Farmer), personalizado com os dados reais do cliente.

${REGRA_SEM_HISTORICO}

${REGRA_DADO_AUSENTE}

Use SEMPRE a tool registrar_plano_tatico. Não responda em texto fora dela.`;

const PERGUNTA_ITEM = {
  type: "object" as const,
  properties: {
    question: { type: "string", description: "Pergunta diagnóstica a fazer ao cliente" },
    purpose: { type: "string", description: "Por que fazer essa pergunta" },
    expected_insight: { type: "string", description: "O que esperar da resposta" },
  },
  required: ["question", "purpose", "expected_insight"],
};

const OBJECAO_ITEM = {
  type: "object" as const,
  properties: {
    objection: { type: "string", description: "Objeção provável do cliente" },
    technical_response: { type: "string", description: "Resposta técnica" },
    economic_response: { type: "string", description: "Resposta econômica" },
    probability: {
      type: ["number", "null"],
      description: "Probabilidade de 0 a 100. null se não der para estimar — não chute.",
    },
  },
  required: ["objection", "technical_response", "economic_response"],
};

const OBJETIVO_PROP = {
  type: "string",
  enum: [...OBJETIVOS_VALIDOS],
  description: "Objetivo estratégico da abordagem",
};

/** Tool do modo essencial: abordagem curta, 3 perguntas, 1 objeção. */
export const TOOL_ESSENCIAL = {
  name: "registrar_plano_tatico",
  description: "Registra o plano tático essencial (rápido) de abordagem ao cliente.",
  input_schema: {
    type: "object" as const,
    properties: {
      strategic_objective: OBJETIVO_PROP,
      approach_strategy: { type: "string", description: "Abordagem ideal em 1-2 frases" },
      diagnostic_questions: { type: "array", items: PERGUNTA_ITEM, description: "Exatamente 3 perguntas" },
      probable_objections: { type: "array", items: OBJECAO_ITEM, description: "1 objeção mais provável" },
    },
    required: ["strategic_objective", "approach_strategy", "diagnostic_questions", "probable_objections"],
  },
};

/** Tool do modo estratégico: acrescenta plano B, implicação, LTV, cenários e riscos. */
export const TOOL_ESTRATEGICO = {
  name: "registrar_plano_tatico",
  description: "Registra o plano tático estratégico completo de abordagem ao cliente.",
  input_schema: {
    type: "object" as const,
    properties: {
      strategic_objective: OBJETIVO_PROP,
      approach_strategy: { type: "string", description: "Abordagem ideal, 3-4 frases" },
      approach_strategy_b: { type: "string", description: "Abordagem alternativa, 2-3 frases, caso a principal falhe" },
      diagnostic_questions: { type: "array", items: PERGUNTA_ITEM, description: "Exatamente 3 perguntas" },
      implication_question: { type: "string", description: "Pergunta de implicação (impacto financeiro/operacional)" },
      offer_transition: { type: "string", description: "Frase de transição para a oferta do bundle" },
      probable_objections: { type: "array", items: OBJECAO_ITEM, description: "Até 3 objeções prováveis" },
      ltv_projection: {
        type: ["object", "null"],
        description: "Projeção de LTV. Use null nos campos que dependeriam de dado não medido.",
        properties: {
          current_annual: { type: ["number", "null"], description: "Faturamento anual atual estimado" },
          projected_annual: { type: ["number", "null"], description: "Faturamento anual projetado após a ação" },
          growth_pct: { type: ["number", "null"], description: "Percentual de crescimento estimado" },
        },
      },
      expected_result: {
        type: ["object", "null"],
        description:
          "Cenários de margem. Se a margem atual do cliente não estiver medida (null no contexto), responda null nos três — não projete margem a partir de dado ausente.",
        properties: {
          best_case_margin: { type: ["number", "null"], description: "Margem no melhor cenário" },
          likely_margin: { type: ["number", "null"], description: "Margem mais provável" },
          worst_case_margin: { type: ["number", "null"], description: "Margem no pior cenário" },
        },
      },
      operational_risks: { type: "array", items: { type: "string" }, description: "Riscos operacionais" },
    },
    required: [
      "strategic_objective",
      "approach_strategy",
      "approach_strategy_b",
      "diagnostic_questions",
      "implication_question",
      "offer_transition",
      "probable_objections",
    ],
  },
};

export function toolDoModo(modo: Modo) {
  return modo === "estrategico" ? TOOL_ESTRATEGICO : TOOL_ESSENCIAL;
}

export function systemDoModo(modo: Modo): string {
  return modo === "estrategico" ? SYSTEM_ESTRATEGICO : SYSTEM_ESSENCIAL;
}

// ---------------------------------------------------------------------------
// Extração do bloco tool_use
// ---------------------------------------------------------------------------

export type BlocoResposta = { type: string; input?: unknown; text?: string };

export type ExtracaoToolUse =
  | { ok: true; input: unknown }
  | { ok: false; motivo: "ausente" | "multiplo"; quantidade: number; texto: string };

/**
 * Exige EXATAMENTE um bloco `tool_use`. Espelha `analyze-unified-order/saida-ia.ts`
 * (mantido local de propósito: acoplar duas edges por um helper de 20 linhas custa mais
 * do que a duplicação — mudou lá, confira aqui).
 *
 * Zero blocos: o modelo respondeu em texto e não há plano.
 * Mais de um: `tool_choice` sem `disable_parallel_tool_use` permite chamada paralela, e
 * consumir só o primeiro entregaria plano PARCIAL com cara de completo (P1 do /codex no #1608).
 */
export function extrairToolUseUnico(content: unknown): ExtracaoToolUse {
  const blocos = Array.isArray(content) ? (content as BlocoResposta[]) : [];
  const usos = blocos.filter((b) => b?.type === "tool_use");
  if (usos.length === 1) return { ok: true, input: usos[0].input };

  const texto = blocos
    .filter((b) => b?.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join(" ")
    .slice(0, 300);

  return {
    ok: false,
    motivo: usos.length === 0 ? "ausente" : "multiplo",
    quantidade: usos.length,
    texto,
  };
}

/**
 * Mapa de erro da API da Anthropic → status HTTP + mensagem acionável.
 * Espelha o do #1608. O 402 é o ponto: crédito esgotado foi o que motivou esta migração,
 * e a Anthropic devolve `billing_error` — sem mapear, a MESMA falha voltaria como 500
 * genérico e o batch noturno registraria `http_500` sem dizer que o problema é saldo.
 */
export function statusDeErroIa(status: number | undefined): { http: number; msg: string } | null {
  if (!status) return null;
  const porStatus: Record<number, { http: number; msg: string }> = {
    400: { http: 400, msg: "A IA recusou o contexto enviado para este cliente." },
    401: { http: 500, msg: "IA mal configurada — avise a equipe." },
    403: { http: 500, msg: "IA mal configurada — avise a equipe." },
    404: { http: 500, msg: "IA mal configurada — avise a equipe." },
    402: { http: 402, msg: "Créditos da IA esgotados — avise a equipe." },
    413: { http: 413, msg: "Contexto do cliente grande demais para analisar." },
    429: { http: 429, msg: "Limite de requisições excedido. Tente novamente em alguns segundos." },
    500: { http: 503, msg: "IA sobrecarregada no momento. Tente de novo em instantes." },
    503: { http: 503, msg: "IA sobrecarregada no momento. Tente de novo em instantes." },
    529: { http: 503, msg: "IA sobrecarregada no momento. Tente de novo em instantes." },
  };
  return porStatus[status] ?? null;
}
