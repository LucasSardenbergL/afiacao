// Helpers PUROS da extração por vision — sem import remoto, para rodar sob
// `deno test --no-remote` (o `test:edges` do CI). A edge (index.ts) importa
// daqui; o SDK da Anthropic e o supabase-js ficam de fora deste módulo.
//
// Guards money-path: percentual extraído por LLM não entra em promoção/aumento
// sem passar por `validarPercentual`. Item fora de faixa é REJEITADO e anotado
// (precisão > recall), nunca gravado com número fabricado.

/** Media types que a API da Anthropic aceita como imagem. */
const MEDIA_TYPES_IMAGEM = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

const MEDIA_TYPE_PDF = "application/pdf";

/** Teto de request da Anthropic (32 MB) com folga para o envelope JSON. */
export const LIMITE_BASE64_BYTES = 30 * 1024 * 1024;

/** Union literal — o SDK da Anthropic tipa `media_type` assim, `string` não casa. */
export type MediaTypeImagem = (typeof MEDIA_TYPES_IMAGEM)[number];

export type BlocoAnexo =
  | {
    type: "image";
    source: { type: "base64"; media_type: MediaTypeImagem; data: string };
  }
  | {
    type: "document";
    source: { type: "base64"; media_type: "application/pdf"; data: string };
  };

export type ResultadoAnexo =
  | { ok: true; bloco: BlocoAnexo; mediaType: string; extensao: string }
  | { ok: false; erro: string };

/**
 * Normaliza o `arquivo_tipo` do body ("pdf" ou o MIME do File) para o media
 * type da Anthropic e monta o content block correspondente.
 *
 * Fail-closed: tipo não suportado vira erro explícito aqui, em vez de um 400
 * opaco vindo da API depois de já termos gasto o upload.
 */
export function montarBlocoAnexo(
  arquivoTipo: string,
  base64: string,
): ResultadoAnexo {
  const tipo = (arquivoTipo ?? "").trim().toLowerCase();
  const dados = (base64 ?? "").trim();

  if (!dados) return { ok: false, erro: "arquivo_base64 vazio" };
  if (dados.length > LIMITE_BASE64_BYTES) {
    const mb = (dados.length / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      erro:
        `arquivo grande demais para a API (${mb} MB em base64; limite ~30 MB). Comprima o PDF ou envie página por página.`,
    };
  }

  if (tipo === "pdf" || tipo === MEDIA_TYPE_PDF) {
    return {
      ok: true,
      mediaType: MEDIA_TYPE_PDF,
      extensao: "pdf",
      bloco: {
        type: "document",
        source: { type: "base64", media_type: MEDIA_TYPE_PDF, data: dados },
      },
    };
  }

  const imagem = MEDIA_TYPES_IMAGEM.find((m) => m === tipo);
  if (imagem) {
    return {
      ok: true,
      mediaType: imagem,
      extensao: imagem === "image/jpeg" ? "jpg" : imagem.slice("image/".length),
      bloco: {
        type: "image",
        source: { type: "base64", media_type: imagem, data: dados },
      },
    };
  }

  return {
    ok: false,
    erro:
      `arquivo_tipo não suportado: "${arquivoTipo}". Aceitos: pdf, ${
        MEDIA_TYPES_IMAGEM.join(", ")
      }.`,
  };
}

/**
 * Guard money-path para percentual extraído pela IA.
 * Devolve `null` (e o caller rejeita a linha) para ausente, não-finito, zero,
 * negativo ou acima de 100 — nenhum desses vira número gravado.
 */
export function validarPercentual(valor: unknown): number | null {
  const n = typeof valor === "number" ? valor : Number(valor);
  if (!Number.isFinite(n)) return null;
  if (n <= 0 || n > 100) return null;
  return n;
}

/** Confiança fora de [0,1] ou ilegível degrada para 0, nunca para um valor inventado. */
export function normalizarConfianca(valor: unknown): number {
  const n = typeof valor === "number" ? valor : Number(valor);
  if (!Number.isFinite(n) || n < 0 || n > 1) return 0;
  return n;
}

/** Aceita apenas YYYY-MM-DD que exista de fato no calendário. */
export function dataValida(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return null;
  const d = new Date(`${texto}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Rejeita overflow silencioso do Date (2026-02-31 → 2026-03-03).
  return d.toISOString().slice(0, 10) === texto ? texto : null;
}

export interface ItemPromo {
  codigo_fornecedor: string;
  descricao: string | null;
  desconto_perc: number;
  volume_minimo: number | null;
}

export interface ItemRejeitado {
  codigo: string;
  motivo: string;
}

export interface ItensNormalizados {
  itens: ItemPromo[];
  rejeitados: ItemRejeitado[];
}

/**
 * Filtra os itens vindos da tool: código não-vazio + desconto dentro da faixa.
 * O que não passa sai da lista e vira `rejeitados` — visível na resposta e nas
 * observações, em vez de virar linha com desconto errado em `promocao_item`.
 */
export function normalizarItensPromo(bruto: unknown): ItensNormalizados {
  const itens: ItemPromo[] = [];
  const rejeitados: ItemRejeitado[] = [];
  if (!Array.isArray(bruto)) return { itens, rejeitados };

  for (const cru of bruto) {
    const linha = (cru ?? {}) as Record<string, unknown>;
    const codigo = typeof linha.codigo_fornecedor === "string"
      ? linha.codigo_fornecedor.trim()
      : "";
    if (!codigo) {
      rejeitados.push({ codigo: "(sem código)", motivo: "codigo_fornecedor ausente" });
      continue;
    }

    const desconto = validarPercentual(linha.desconto_perc);
    if (desconto === null) {
      rejeitados.push({
        codigo,
        motivo: `desconto_perc fora da faixa (0,100]: ${JSON.stringify(linha.desconto_perc)}`,
      });
      continue;
    }

    const volumeBruto = typeof linha.volume_minimo === "number"
      ? linha.volume_minimo
      : Number(linha.volume_minimo);
    const volume = Number.isFinite(volumeBruto) && volumeBruto > 0
      ? volumeBruto
      : null;

    itens.push({
      codigo_fornecedor: codigo,
      descricao: typeof linha.descricao === "string" && linha.descricao.trim()
        ? linha.descricao.trim()
        : null,
      desconto_perc: desconto,
      volume_minimo: volume,
    });
  }

  return { itens, rejeitados };
}

export interface CategoriaAumento {
  categoria_fornecedor: string;
  aumento_perc: number;
  data_vigencia_especifica: string | null;
}

export interface CategoriasNormalizadas {
  categorias: CategoriaAumento[];
  rejeitadas: ItemRejeitado[];
}

/** Mesma disciplina de `normalizarItensPromo`, para as categorias do aumento. */
export function normalizarCategoriasAumento(
  bruto: unknown,
): CategoriasNormalizadas {
  const categorias: CategoriaAumento[] = [];
  const rejeitadas: ItemRejeitado[] = [];
  if (!Array.isArray(bruto)) return { categorias, rejeitadas };

  for (const cru of bruto) {
    const linha = (cru ?? {}) as Record<string, unknown>;
    const nome = typeof linha.categoria_fornecedor === "string"
      ? linha.categoria_fornecedor.trim()
      : "";
    if (!nome) {
      rejeitadas.push({
        codigo: "(sem categoria)",
        motivo: "categoria_fornecedor ausente",
      });
      continue;
    }

    const aumento = validarPercentual(linha.aumento_perc);
    if (aumento === null) {
      rejeitadas.push({
        codigo: nome,
        motivo: `aumento_perc fora da faixa (0,100]: ${JSON.stringify(linha.aumento_perc)}`,
      });
      continue;
    }

    categorias.push({
      categoria_fornecedor: nome,
      aumento_perc: aumento,
      data_vigencia_especifica: dataValida(linha.data_vigencia_especifica),
    });
  }

  return { categorias, rejeitadas };
}

/** Anexa o relatório de rejeições às observações que vão para o revisor humano. */
export function anotarRejeicoes(
  observacoes: string,
  rejeitados: ItemRejeitado[],
): string {
  if (rejeitados.length === 0) return observacoes;
  const lista = rejeitados
    .map((r) => `${r.codigo}: ${r.motivo}`)
    .join("; ");
  const aviso =
    `[${rejeitados.length} linha(s) DESCARTADA(S) por valor inválido — revisar no documento original] ${lista}`;
  return observacoes ? `${observacoes} ${aviso}` : aviso;
}
