// Tool e guards da identificação de ferramenta por foto — puros, sem import
// remoto (rodam sob `deno test --no-remote`, o `test:edges` do CI).
//
// O que a saída vira: a tela preenche categoria e serviços sugeridos do pedido
// de afiação a partir daqui. Categoria errada leva a ferramenta para a linha de
// serviço errada; serviço inventado vira item cobrado que ninguém executou.
//
// O fallback antigo já era HONESTO (`identified: false`, "não foi possível
// analisar") — este módulo preserva essa honestidade e adiciona o que faltava:
// a categoria devolvida tem de existir de fato entre as CADASTRADAS, senão o
// nome plausível vindo do modelo entra como se fosse do catálogo.

export interface FerramentaIdentificada {
  identified: boolean;
  category_name: string | null;
  confidence: "alta" | "media" | "baixa";
  description: string;
  specs_detected: Record<string, string>;
  suggested_services: string[];
}

const CONFIANCAS = ["alta", "media", "baixa"] as const;

export const TOOL_FERRAMENTA = {
  name: "identificar_ferramenta",
  description:
    "Retorna a ferramenta de corte industrial identificada na foto, a categoria correspondente e os serviços sugeridos.",
  input_schema: {
    type: "object" as const,
    properties: {
      identified: { type: "boolean", description: "true se a ferramenta foi reconhecida" },
      category_name: {
        type: ["string", "null"],
        description: "Nome EXATO de uma das categorias cadastradas; null se nenhuma corresponder",
      },
      confidence: { type: "string", enum: [...CONFIANCAS], description: "Confiança na identificação" },
      description: { type: "string", description: "Descrição breve do que foi identificado" },
      specs_detected: {
        type: "object",
        description: "Especificações visíveis na foto (diâmetro, nº de dentes, material, geometria)",
        additionalProperties: true,
      },
      suggested_services: {
        type: "array",
        items: { type: "string" },
        description: "Serviços sugeridos (ex.: Afiação, Retífica, Troca de dentes)",
      },
    },
    required: ["identified", "confidence", "description"],
  },
};

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Resposta honesta quando não há leitura utilizável — nunca um chute. */
export function naoIdentificada(motivo: string): FerramentaIdentificada {
  return {
    identified: false,
    category_name: null,
    confidence: "baixa",
    description: motivo,
    specs_detected: {},
    suggested_services: [],
  };
}

/**
 * Normaliza a saída da tool.
 *
 * `categoriasCadastradas` é a lista REAL do sistema: a categoria só passa se
 * existir nela (comparação sem caixa/acento-sensível ao trim). Uma categoria
 * plausível porém inexistente — "Serra Circular Widia" quando o cadastro tem
 * "Serra Circular" — viraria um vínculo que não resolve, e a tela mostraria
 * como se tivesse casado com o catálogo.
 */
export function normalizarFerramenta(
  bruto: unknown,
  categoriasCadastradas: readonly string[],
): FerramentaIdentificada | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const o = bruto as Record<string, unknown>;

  const confianca = texto(o.confidence).toLowerCase();
  if (!(CONFIANCAS as readonly string[]).includes(confianca)) return null;

  const descricao = texto(o.description);
  if (!descricao) return null;

  const identificada = o.identified === true;

  // Categoria: só vale se casar com uma cadastrada.
  const bruta = texto(o.category_name);
  let categoria: string | null = null;
  if (bruta) {
    const alvo = bruta.toLowerCase();
    categoria = categoriasCadastradas.find((c) => c.trim().toLowerCase() === alvo) ?? null;
  }

  const servicos: string[] = [];
  if (Array.isArray(o.suggested_services)) {
    for (const cru of o.suggested_services) {
      const t = texto(cru);
      if (t) servicos.push(t);
    }
  }

  // Só ESCALARES. A tela renderiza cada valor direto em `<span>{value}</span>`;
  // um objeto aninhado (`{ diametro: { valor: 250 } }`) lança "Objects are not
  // valid as a React child" e derruba a página inteira.
  const specs: Record<string, string> = {};
  if (o.specs_detected && typeof o.specs_detected === "object" && !Array.isArray(o.specs_detected)) {
    for (const [chave, valor] of Object.entries(o.specs_detected as Record<string, unknown>)) {
      if (typeof valor === "string" && valor.trim()) specs[chave] = valor.trim();
      else if (typeof valor === "number" && Number.isFinite(valor)) specs[chave] = String(valor);
      else if (typeof valor === "boolean") specs[chave] = valor ? "sim" : "não";
    }
  }

  return {
    // Sem categoria casada não há o que confirmar: a tela mostraria check verde
    // e o botão "Usar esta ferramenta" retornaria calado (ele exige
    // `category_name`). Melhor dizer que não identificou.
    identified: identificada && categoria !== null,
    category_name: categoria,
    confidence: confianca as FerramentaIdentificada["confidence"],
    description: descricao,
    specs_detected: specs,
    suggested_services: servicos,
  };
}
