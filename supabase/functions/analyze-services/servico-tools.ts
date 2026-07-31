// Tool e guards da identificação de serviços por voz/texto — puros, sem import
// remoto (rodam sob `deno test --no-remote`, o `test:edges` do CI).
//
// O que a saída vira: itens de um pedido de afiação. `quantity` é multiplicada
// pelo preço do serviço, então string ou zero aqui vira valor errado na nota.
//
// Esta edge já validava o `userToolId` contra as ferramentas reais do cliente —
// o que faltava era a disciplina de TIPO nos números, a mesma que o challenge do
// Codex expôs na fase 2: forced tool-use garante que a ferramenta foi usada, não
// que os tipos declarados no schema foram respeitados.

export interface ItemServico {
  userToolId: string;
  omie_codigo_servico: number;
  servico_descricao: string;
  quantity: number;
  notes?: string;
}

export const TOOL_SERVICOS = {
  name: "suggest_services",
  description: "Retorna as ferramentas e serviços identificados no texto do cliente",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        description: "Lista de itens identificados (ferramenta + serviço)",
        items: {
          type: "object",
          properties: {
            userToolId: { type: "string", description: "ID da ferramenta cadastrada do usuário" },
            omie_codigo_servico: { type: "number", description: "Código do serviço no Omie" },
            servico_descricao: { type: "string", description: "Descrição do serviço" },
            quantity: { type: "number", description: "Quantidade de itens (padrão 1)" },
            notes: { type: "string", description: "Observações extraídas do texto (danos, urgência, etc)" },
          },
          required: ["userToolId", "omie_codigo_servico", "servico_descricao", "quantity"],
        },
      },
      message: {
        type: "string",
        description: "Mensagem amigável para o cliente confirmando o que foi identificado",
      },
    },
    required: ["items", "message"],
  },
};

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Número finito; string numérica LIMPA é aceita, o ambíguo não. */
export function numeroFinito(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Quantidade inválida cai no default 1 — o declarado no próprio schema
 * ("padrão 1"), não um número inventado. `undefined` viraria NaN ao multiplicar
 * pelo preço; `"2"` string faria a soma concatenar.
 */
export function quantidadeValida(v: unknown): number {
  const n = numeroFinito(v);
  return n !== null && n > 0 ? n : 1;
}

export interface ItensNormalizados {
  itens: ItemServico[];
  descartados: number;
}

/**
 * Mantém só item com ferramenta REAL do cliente e código de serviço numérico.
 *
 * `idsValidos` são as ferramentas cadastradas: um `userToolId` inventado viraria
 * item órfão no pedido. `omie_codigo_servico` ilegível derruba a linha inteira —
 * sem código não há o que faturar, e adivinhar aqui erra o serviço cobrado.
 */
export function normalizarItens(
  bruto: unknown,
  idsValidos: ReadonlySet<string>,
): ItensNormalizados {
  if (!Array.isArray(bruto)) return { itens: [], descartados: 0 };

  const itens: ItemServico[] = [];
  let descartados = 0;

  for (const cru of bruto) {
    if (!cru || typeof cru !== "object" || Array.isArray(cru)) {
      descartados++;
      continue;
    }
    const o = cru as Record<string, unknown>;

    const userToolId = texto(o.userToolId);
    if (!userToolId || !idsValidos.has(userToolId)) {
      descartados++;
      continue;
    }

    const codigo = numeroFinito(o.omie_codigo_servico);
    if (codigo === null) {
      descartados++;
      continue;
    }

    const descricao = texto(o.servico_descricao);
    if (!descricao) {
      descartados++;
      continue;
    }

    const notes = texto(o.notes);
    itens.push({
      userToolId,
      omie_codigo_servico: codigo,
      servico_descricao: descricao,
      quantity: quantidadeValida(o.quantity),
      ...(notes ? { notes } : {}),
    });
  }

  return { itens, descartados };
}
