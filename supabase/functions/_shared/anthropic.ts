// Peças comuns das chamadas à API da Anthropic nas edges — puras o bastante para
// rodar sob `deno test --no-remote` (nada aqui importa o SDK; o cliente é
// construído na própria edge).
//
// Existe porque o mapeamento de erro é sutil e errar nele é SILENCIOSO: sem o
// 402, saldo esgotado vira "erro interno" e ninguém descobre que o problema é
// crédito — foi exatamente o que aconteceu com o gateway do Lovable, cujo
// estouro de orçamento derrubou as features de IA sem sinal claro.

/** Modelo padrão das edges — ver convenção de LLM em edge no CLAUDE.md. */
export const MODELO_PADRAO = "claude-sonnet-4-6";

export interface RespostaErro {
  http: number;
  mensagem: string;
}

/**
 * Traduz o status da API da Anthropic para a resposta que a edge devolve.
 *
 * `null` = não é erro conhecido da API: o caller deve tratar como falha interna
 * (500) em vez de inventar uma mensagem tranquilizadora para o usuário.
 */
export function traduzirErroAnthropic(status: number | undefined): RespostaErro | null {
  switch (status) {
    // 400 é REQUISIÇÃO INVÁLIDA — schema/parâmetro incompatível, quase sempre
    // defeito nosso. Recusa do modelo por conteúdo NÃO chega como 400: vem numa
    // resposta 200 com `stop_reason: "refusal"`. Chamar isto de "a IA recusou"
    // mandaria a vendedora tentar outra foto quando o bug é do código.
    case 400:
      return { http: 500, mensagem: "Falha na requisição à IA — avise a equipe." };
    case 401:
    case 403:
    case 404:
      return { http: 500, mensagem: "IA mal configurada — avise a equipe." };
    case 402:
      return { http: 402, mensagem: "Créditos da IA esgotados — avise a equipe." };
    case 409:
      return { http: 409, mensagem: "Conflito momentâneo na IA. Tente novamente." };
    case 413:
      return { http: 413, mensagem: "Envio grande demais para a IA." };
    case 429:
      return { http: 429, mensagem: "Limite de requisições excedido. Tente novamente em alguns segundos." };
    case 500:
    case 503:
    case 504:
    case 529:
      return { http: 503, mensagem: "IA sobrecarregada no momento. Tente de novo em instantes." };
    default:
      return null;
  }
}

/** Extrai o status HTTP de um erro do SDK sem assumir o formato. */
export function statusDoErro(e: unknown): number | undefined {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

export type ResultadoToolUse =
  | { ok: true; input: unknown }
  | { ok: false; motivo: "ausente" | "multiplo"; quantidade: number };

/**
 * Exige EXATAMENTE um bloco `tool_use`.
 *
 * `tool_choice: {type:"tool"}` sozinho NÃO desliga chamada paralela — o modelo
 * pode emitir vários blocos. Consumir só o primeiro entrega resultado PARCIAL
 * com cara de completo. Mande `disable_parallel_tool_use: true` na chamada;
 * este guard é a rede.
 */
export function extrairToolUseUnico(
  blocos: ReadonlyArray<{ type: string; input?: unknown }>,
): ResultadoToolUse {
  const usos = (blocos ?? []).filter((b) => b?.type === "tool_use");
  if (usos.length === 0) return { ok: false, motivo: "ausente", quantidade: 0 };
  if (usos.length > 1) {
    return { ok: false, motivo: "multiplo", quantidade: usos.length };
  }
  return { ok: true, input: usos[0].input };
}

/**
 * Objeto utilizável a partir do `input` da tool.
 *
 * Forced tool-use garante que a ferramenta foi USADA, não que o schema foi
 * respeitado (isso só com `strict:true`). Entrada que não é objeto vira `null`
 * para o caller falhar explicitamente, em vez de seguir com campos `undefined`
 * e gravar um registro vazio que parece preenchido.
 */
export function objetoDaTool(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}
