// Tool e guards do copiloto de ligação — puros, sem import remoto (rodam sob
// `deno test --no-remote`, o `test:edges` do CI).
//
// Contexto: isto roda AO VIVO, enquanto a vendedora está ao telefone. A tela
// mostra "intenção do cliente", "direção da conversa" e uma sugestão de próxima
// fala. Ela age na hora, sem tempo de conferir.
//
// O que estava errado: no `catch` do JSON.parse a edge fabricava a análise —
//   { intent: 'indiferenca', direction: 'neutro', confidence: 30,
//     suggestion: 'Continue explorando as necessidades do cliente.' }
// — e devolvia com cara de leitura real. "Indiferença" e "neutro" são AFIRMAÇÕES
// sobre o cliente; `confidence: 30` é um número que ninguém mediu. Uma conversa
// que estava em RISCO aparecia como neutra, e a vendedora seguia tranquila.
//
// Agora: ou a tool devolve os campos válidos, ou o caller responde 422 e a tela
// mostra que a análise não veio. Sem leitura é pior que leitura errada? Não —
// leitura errada é pior, porque ela AGE sobre ela.

export const INTENCOES = [
  "interesse",
  "objecao_preco",
  "objecao_tecnica",
  "falta_urgencia",
  "comparacao_concorrente",
  "indiferenca",
] as const;

export const FASES = [
  "abertura",
  "diagnostico",
  "exploracao",
  "proposta",
  "fechamento",
] as const;

export const DIRECOES = ["positivo", "neutro", "risco"] as const;

export const TIPOS_SUGESTAO = [
  "pergunta_diagnostica",
  "resposta_tecnica",
  "argumento_economico",
  "alternativa_abordagem",
] as const;

export type Intencao = (typeof INTENCOES)[number];
export type Fase = (typeof FASES)[number];
export type Direcao = (typeof DIRECOES)[number];
export type TipoSugestao = (typeof TIPOS_SUGESTAO)[number];

export interface AnaliseCopiloto {
  intent: Intencao;
  phase: Fase;
  direction: Direcao;
  direction_reasons: string[];
  suggestion: string;
  suggestion_type: TipoSugestao;
  confidence: number;
}

export const TOOL_COPILOTO = {
  name: "analisar_conversa",
  description:
    "Retorna a leitura da conversa em andamento: intenção do cliente, fase da venda, direção e a próxima ação sugerida ao vendedor.",
  input_schema: {
    type: "object" as const,
    properties: {
      intent: { type: "string", enum: [...INTENCOES], description: "Intenção predominante do cliente" },
      phase: { type: "string", enum: [...FASES], description: "Fase atual da venda" },
      direction: { type: "string", enum: [...DIRECOES], description: "Direção da conversa pelo sentimento geral" },
      direction_reasons: {
        type: "array",
        items: { type: "string" },
        description: "Sinais curtos que sustentam a direção",
      },
      suggestion: { type: "string", description: "UMA próxima ação concisa (máx. 3 linhas)" },
      suggestion_type: { type: "string", enum: [...TIPOS_SUGESTAO], description: "Natureza da sugestão" },
      confidence: { type: "number", description: "Confiança na leitura, 0 a 100" },
    },
    required: [
      "intent",
      "phase",
      "direction",
      "direction_reasons",
      "suggestion",
      "suggestion_type",
      "confidence",
    ],
  },
};

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function doEnum<T extends string>(v: unknown, permitidos: readonly T[]): T | null {
  const t = texto(v).toLowerCase();
  return (permitidos as readonly string[]).includes(t) ? (t as T) : null;
}

/**
 * Confiança 0–100 ou `null`.
 *
 * `null` NÃO vira 0 nem um número de consolo: sem confiança medida, o caller
 * descarta a análise inteira. Era `confidence: 30` fixo no fallback — um número
 * que a tela exibia como se fosse medição.
 */
export function confiancaValida(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return n >= 0 && n <= 100 ? n : null;
}

/** Motivos: só strings não-vazias. Lista de objetos derrubaria a renderização. */
export function motivosValidos(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const cru of v) {
    const t = texto(cru);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Valida a análise inteira. Devolve `null` se QUALQUER campo que a tela afirma
 * ao vendedor estiver ausente ou fora do enum — é tudo ou nada de propósito:
 * meia análise (intenção sem direção, sugestão sem tipo) chega à tela com a
 * mesma aparência de uma leitura completa.
 */
export function normalizarAnalise(bruto: unknown): AnaliseCopiloto | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const o = bruto as Record<string, unknown>;

  const intent = doEnum(o.intent, INTENCOES);
  const phase = doEnum(o.phase, FASES);
  const direction = doEnum(o.direction, DIRECOES);
  const suggestionType = doEnum(o.suggestion_type, TIPOS_SUGESTAO);
  const suggestion = texto(o.suggestion);
  const confidence = confiancaValida(o.confidence);

  if (
    intent === null || phase === null || direction === null ||
    suggestionType === null || !suggestion || confidence === null
  ) {
    return null;
  }

  return {
    intent,
    phase,
    direction,
    direction_reasons: motivosValidos(o.direction_reasons),
    suggestion,
    suggestion_type: suggestionType,
    confidence,
  };
}
