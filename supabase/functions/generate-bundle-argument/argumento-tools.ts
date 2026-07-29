// Schemas das tools e normalização da saída — puro, sem import remoto
// (roda sob `deno test --no-remote`, o `test:edges` do CI).
//
// Por que forced tool-use: o código antigo pedia JSON no texto, fazia
// `content.match(/\{[\s\S]*\}/)` + `JSON.parse`, e no catch montava um objeto
// de fallback com dois problemas graves:
//
//   versao_whatsapp: content.slice(0, 150)   ← texto CRU do modelo virando a
//                                              mensagem enviada AO CLIENTE
//   beneficio_economico: "Economia potencial identificada"  ← afirmação
//                                              econômica fabricada
//
// Com tool-use o schema é satisfeito ou a chamada falha explícito — não existe
// mensagem de WhatsApp montada a partir de raciocínio truncado do modelo.

const TIPOS_SPIN = ["situacao", "problema", "implicacao", "direcionamento"] as const;

export const TOOL_PERGUNTAS = {
  name: "registrar_perguntas_diagnosticas",
  description: "Registra as perguntas diagnósticas SPIN para validar hipóteses antes do bundle",
  input_schema: {
    type: "object" as const,
    properties: {
      questions: {
        type: "array",
        description: "Máximo 4 perguntas, uma por tipo SPIN",
        items: {
          type: "object" as const,
          properties: {
            type: { type: "string", enum: [...TIPOS_SPIN] },
            main: { type: "string", description: "Pergunta principal" },
            alt: { type: "string", description: "Variação alternativa adaptada ao perfil" },
            rationale: { type: "string", description: "Por que esta pergunta é relevante" },
          },
          required: ["type", "main", "alt", "rationale"],
        },
      },
    },
    required: ["questions"],
  },
};

export const TOOL_ARGUMENTO = {
  name: "registrar_argumentacao",
  description: "Registra a argumentação consultiva personalizada para a venda do bundle",
  input_schema: {
    type: "object" as const,
    properties: {
      diagnostico: { type: "string", description: "Diagnóstico implícito baseado no histórico" },
      insight_tecnico: { type: "string", description: "Insight sobre o processo produtivo" },
      beneficio_operacional: { type: "string", description: "Benefício operacional concreto" },
      beneficio_economico: {
        type: "string",
        description:
          "Benefício econômico. Use APENAS cifras presentes no contexto; sem número disponível, escreva de forma qualitativa — não estime economia, payback nem percentual.",
      },
      objecao_antecipada: { type: "string", description: "Objeção provável e resposta" },
      versao_phone: { type: "string", description: "Script curto para ligação" },
      versao_whatsapp: { type: "string", description: "Mensagem resumida para WhatsApp" },
      versao_tecnica: { type: "string", description: "Versão técnica completa" },
    },
    required: [
      "diagnostico",
      "insight_tecnico",
      "beneficio_operacional",
      "beneficio_economico",
      "objecao_antecipada",
      "versao_phone",
      "versao_whatsapp",
      "versao_tecnica",
    ],
  },
};

function texto(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : "";
}

export interface PerguntaSpin {
  type: string;
  main: string;
  alt: string;
  rationale: string;
}

/**
 * Mantém só pergunta com tipo SPIN conhecido e enunciado não-vazio.
 * Pergunta sem `main` apareceria como item em branco na tela da vendedora.
 */
export function normalizarPerguntas(bruto: unknown): PerguntaSpin[] {
  const lista = (bruto as { questions?: unknown })?.questions;
  if (!Array.isArray(lista)) return [];

  const out: PerguntaSpin[] = [];
  for (const cru of lista) {
    if (!cru || typeof cru !== "object") continue;
    const item = cru as Record<string, unknown>;
    const tipo = texto(item.type).toLowerCase();
    const main = texto(item.main);
    if (!main) continue;
    if (!(TIPOS_SPIN as readonly string[]).includes(tipo)) continue;
    out.push({
      type: tipo,
      main,
      alt: texto(item.alt),
      rationale: texto(item.rationale),
    });
  }
  return out;
}

export interface Argumentacao {
  diagnostico: string;
  insight_tecnico: string;
  beneficio_operacional: string;
  beneficio_economico: string;
  objecao_antecipada: string;
  versao_phone: string;
  versao_whatsapp: string;
  versao_tecnica: string;
}

/**
 * TODOS os campos são essenciais: a tela mostra as cinco linhas de argumentação
 * e as três abas (phone/whatsapp/técnica) incondicionalmente, com botão de
 * copiar. Campo vazio vira linha em branco que a vendedora copia e manda ao
 * cliente. Como a geração é retriável e não há como recuperar um campo perdido,
 * é tudo ou nada de verdade.
 */
export const CAMPOS_ESSENCIAIS = [
  "diagnostico",
  "insight_tecnico",
  "beneficio_operacional",
  "beneficio_economico",
  "objecao_antecipada",
  "versao_phone",
  "versao_whatsapp",
  "versao_tecnica",
] as const;

export function normalizarArgumentacao(bruto: unknown): Argumentacao | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const o = bruto as Record<string, unknown>;

  const arg: Argumentacao = {
    diagnostico: texto(o.diagnostico),
    insight_tecnico: texto(o.insight_tecnico),
    beneficio_operacional: texto(o.beneficio_operacional),
    beneficio_economico: texto(o.beneficio_economico),
    objecao_antecipada: texto(o.objecao_antecipada),
    versao_phone: texto(o.versao_phone),
    versao_whatsapp: texto(o.versao_whatsapp),
    versao_tecnica: texto(o.versao_tecnica),
  };

  // Sem os essenciais não há argumentação utilizável. Devolver o objeto pela
  // metade faria a tela abrir com campos em branco e a vendedora mandar uma
  // mensagem vazia para o cliente.
  for (const campo of CAMPOS_ESSENCIAIS) {
    if (!arg[campo]) return null;
  }
  return arg;
}
