// Schema da tool e normalização do plano tático — puro, sem import remoto
// (roda sob `deno test --no-remote`, o `test:edges` do CI).
//
// Por que forced tool-use: o código antigo pedia "retorne APENAS o JSON" no
// texto e fazia `JSON.parse` depois de raspar ```json. Quando o parse falhava,
// montava um plano GENÉRICO ("Abordagem consultiva padrão", perguntas padrão) —
// que no modo cron era GRAVADO via criar_plano_tatico sem nenhuma marca de
// fallback. A vendedora abria o plano do cliente e lia recomendação genérica
// achando que era análise daquele cliente. Com tool-use, ou o schema é
// satisfeito, ou é erro explícito: não existe plano inventado.
//
// Money-path do schema: o prompt manda deixar `null` quando a margem não está
// medida ("NUNCA estime, preencha ou infira"). Portanto os campos de projeção
// são NULLABLE de propósito — um schema que os obrigasse forçaria exatamente a
// fabricação que o prompt proíbe.

export const OBJETIVOS_ESTRATEGICOS = [
  "ativacao",
  "recuperacao",
  "expansao_mix",
  "upsell_premium",
  "reativacao",
  "consolidacao_margem",
] as const;

export type ObjetivoEstrategico = (typeof OBJETIVOS_ESTRATEGICOS)[number];

const PERGUNTA_DIAGNOSTICA = {
  type: "object" as const,
  properties: {
    question: { type: "string", description: "Pergunta diagnóstica" },
    purpose: { type: "string", description: "Por que fazer essa pergunta" },
    expected_insight: { type: "string", description: "O que esperar da resposta" },
  },
  required: ["question", "purpose", "expected_insight"],
};

const OBJECAO = {
  type: "object" as const,
  properties: {
    objection: { type: "string", description: "Objeção provável" },
    technical_response: { type: "string", description: "Resposta técnica" },
    economic_response: { type: "string", description: "Resposta econômica" },
    probability: { type: "number", description: "Probabilidade de 0 a 100" },
  },
  required: ["objection", "technical_response", "economic_response", "probability"],
};

/** Campos comuns aos dois modos. */
const BASE = {
  strategic_objective: {
    type: "string",
    enum: [...OBJETIVOS_ESTRATEGICOS],
    description:
      "Objetivo estratégico. Se salesHistoryStatus for 'sem_historico', use 'ativacao' — não assuma relação prévia.",
  },
  approach_strategy: { type: "string", description: "Abordagem ideal" },
  diagnostic_questions: {
    type: "array",
    items: PERGUNTA_DIAGNOSTICA,
    description: "Exatamente 3 perguntas diagnósticas",
  },
  probable_objections: { type: "array", items: OBJECAO },
};

export const TOOL_PLANO_ESSENCIAL = {
  name: "registrar_plano_tatico",
  description: "Registra o Plano Tático ESSENCIAL (rápido) para o vendedor",
  input_schema: {
    type: "object" as const,
    properties: { ...BASE },
    required: [
      "strategic_objective",
      "approach_strategy",
      "diagnostic_questions",
      "probable_objections",
    ],
  },
};

export const TOOL_PLANO_ESTRATEGICO = {
  name: "registrar_plano_tatico",
  description: "Registra o Plano Tático ESTRATÉGICO COMPLETO para o vendedor",
  input_schema: {
    type: "object" as const,
    properties: {
      ...BASE,
      approach_strategy_b: {
        type: "string",
        description: "Abordagem alternativa caso a principal falhe",
      },
      implication_question: {
        type: "string",
        description: "Pergunta de implicação (impacto financeiro/operacional)",
      },
      offer_transition: { type: "string", description: "Transição para a oferta do bundle" },
      // NULLABLE de propósito: projetar faturamento sobre dado ausente entrega
      // à vendedora um número que parece medido e não é.
      ltv_projection: {
        type: ["object", "null"],
        description: "null se não houver base medida para projetar",
        properties: {
          current_annual: { type: ["number", "null"] },
          projected_annual: { type: ["number", "null"] },
          growth_pct: { type: ["number", "null"] },
        },
      },
      // NULLABLE nos três cenários: é o que o prompt exige quando a margem
      // atual do cliente é null (não medida).
      expected_result: {
        type: ["object", "null"],
        description: "null (ou os três cenários null) quando a margem não está medida",
        properties: {
          best_case_margin: { type: ["number", "null"] },
          likely_margin: { type: ["number", "null"] },
          worst_case_margin: { type: ["number", "null"] },
        },
      },
      operational_risks: { type: "array", items: { type: "string" } },
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

export function toolDoModo(mode: string) {
  return mode === "estrategico" ? TOOL_PLANO_ESTRATEGICO : TOOL_PLANO_ESSENCIAL;
}

/** Número medido ou `null` — nunca 0 como substituto de "não sei". */
export function numeroOuNulo(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  if (typeof valor === "string") {
    const t = valor.trim();
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface ProjecaoNormalizada {
  [campo: string]: number | null;
}

/**
 * Normaliza um objeto de projeção (ltv_projection / expected_result).
 *
 * ALL-OR-NULL: basta UM membro ilegível para o objeto inteiro virar `null`.
 * Não é preciosismo — a UI renderiza `fmt(v) = v.toLocaleString(...)` depois de
 * checar só se o OBJETO existe (`plan.ltvProjection && …`), então um membro
 * `null` chega em `fmt(null)` e derruba a tela do plano. Projeção pela metade
 * também não é projeção: melhor não mostrar do que mostrar 1 de 3 números como
 * se fosse o quadro completo.
 */
export function normalizarProjecao(
  bruto: unknown,
  campos: readonly string[],
): ProjecaoNormalizada | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const origem = bruto as Record<string, unknown>;
  const out: ProjecaoNormalizada = {};
  for (const campo of campos) {
    const n = numeroOuNulo(origem[campo]);
    if (n === null) return null;
    out[campo] = n;
  }
  return out;
}

export const CAMPOS_LTV = ["current_annual", "projected_annual", "growth_pct"] as const;
export const CAMPOS_RESULTADO = [
  "best_case_margin",
  "likely_margin",
  "worst_case_margin",
] as const;

export interface PlanoNormalizado {
  strategic_objective: string | null;
  approach_strategy: string;
  approach_strategy_b: string;
  diagnostic_questions: PerguntaDiagnostica[];
  implication_question: string;
  offer_transition: string;
  probable_objections: ObjecaoNormalizada[];
  ltv_projection: ProjecaoNormalizada | null;
  expected_result: ProjecaoNormalizada | null;
  operational_risks: string[];
}

function texto(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : "";
}

export interface PerguntaDiagnostica {
  question: string;
  purpose: string;
  expected_insight: string;
}

/** Pergunta sem enunciado apareceria como item em branco na tela da vendedora. */
export function normalizarPerguntas(bruto: unknown): PerguntaDiagnostica[] {
  if (!Array.isArray(bruto)) return [];
  const out: PerguntaDiagnostica[] = [];
  for (const cru of bruto) {
    if (!cru || typeof cru !== "object" || Array.isArray(cru)) continue;
    const o = cru as Record<string, unknown>;
    const question = texto(o.question);
    if (!question) continue;
    out.push({
      question,
      purpose: texto(o.purpose),
      expected_insight: texto(o.expected_insight),
    });
  }
  return out;
}

export interface ObjecaoNormalizada {
  objection: string;
  technical_response: string;
  economic_response: string;
  probability: number | null;
}

/** Objeção sem enunciado não é objeção; probabilidade ilegível vira null, não 0. */
export function normalizarObjecoes(bruto: unknown): ObjecaoNormalizada[] {
  if (!Array.isArray(bruto)) return [];
  const out: ObjecaoNormalizada[] = [];
  for (const cru of bruto) {
    if (!cru || typeof cru !== "object" || Array.isArray(cru)) continue;
    const o = cru as Record<string, unknown>;
    const objection = texto(o.objection);
    if (!objection) continue;
    const p = numeroOuNulo(o.probability);
    out.push({
      objection,
      technical_response: texto(o.technical_response),
      economic_response: texto(o.economic_response),
      probability: p !== null && p >= 0 && p <= 100 ? p : null,
    });
  }
  return out;
}

/**
 * Riscos são renderizados como `<span>{risk}</span>`. Um objeto aí dentro
 * derruba o React inteiro ("Objects are not valid as a React child"), então só
 * string não-vazia passa.
 */
export function normalizarRiscos(bruto: unknown): string[] {
  if (!Array.isArray(bruto)) return [];
  const out: string[] = [];
  for (const cru of bruto) {
    const t = texto(cru);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Normaliza a saída da tool para o formato que a RPC/UI consomem.
 *
 * `strategic_objective` fora do enum vira `null` — o caller decide se cai no
 * objetivo derivado server-side (que é medido) em vez de aceitar um rótulo
 * inventado que mudaria a estratégia de abordagem do cliente.
 */
export function normalizarPlano(bruto: Record<string, unknown>): PlanoNormalizado {
  const objetivo = texto(bruto.strategic_objective);
  const objetivoValido = (OBJETIVOS_ESTRATEGICOS as readonly string[]).includes(objetivo);

  return {
    strategic_objective: objetivoValido ? objetivo : null,
    approach_strategy: texto(bruto.approach_strategy),
    approach_strategy_b: texto(bruto.approach_strategy_b),
    diagnostic_questions: normalizarPerguntas(bruto.diagnostic_questions),
    implication_question: texto(bruto.implication_question),
    offer_transition: texto(bruto.offer_transition),
    probable_objections: normalizarObjecoes(bruto.probable_objections),
    ltv_projection: normalizarProjecao(bruto.ltv_projection, CAMPOS_LTV),
    expected_result: normalizarProjecao(bruto.expected_result, CAMPOS_RESULTADO),
    operational_risks: normalizarRiscos(bruto.operational_risks),
  };
}

/**
 * Reconcilia o objetivo da IA com o derivado no servidor.
 *
 * `sem_historico → ativacao` é a PRIMEIRA regra de `selectObjective` e vem de um
 * fato binário verificável: não existe venda válida registrada. Se a IA devolve
 * "recuperacao" ali, ela passa no enum mas contradiz o fato — e um plano de
 * recuperação pressupõe uma relação que nunca existiu. Nesse caso o servidor
 * vence. Nos demais objetivos (faixas de churn/mix/recência, heurísticas), a
 * leitura da IA continua valendo.
 */
export function objetivoFinal(
  daIA: string | null,
  doServidor: string | null | undefined,
): { objetivo: string | null; sobrescrito: boolean } {
  if (doServidor === "ativacao" && daIA !== null && daIA !== "ativacao") {
    return { objetivo: "ativacao", sobrescrito: true };
  }
  return { objetivo: daIA ?? doServidor ?? null, sobrescrito: false };
}

/**
 * Um plano sem conteúdo acionável não vale ser gravado: entregaria à vendedora
 * uma tela preenchida sem orientação real.
 *
 * O modo estratégico é mais exigente porque a tela dele TEM as seções de
 * abordagem B, implicação e transição — gravar sem elas abre um plano
 * "completo" com metade dos blocos vazios.
 */
export function planoTemConteudo(
  plano: PlanoNormalizado,
  mode = "essencial",
): boolean {
  const base = plano.approach_strategy.length > 0 &&
    plano.diagnostic_questions.length > 0;
  if (!base) return false;
  if (mode !== "estrategico") return true;
  return (
    plano.approach_strategy_b.length > 0 &&
    plano.implication_question.length > 0 &&
    plano.offer_transition.length > 0
  );
}
