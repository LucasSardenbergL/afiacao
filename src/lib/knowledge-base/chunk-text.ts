export interface Chunk {
  content: string;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
}

export interface ChunkOptions {
  maxTokens: number;
  overlap: number;
}

const CHARS_PER_TOKEN = 4; // heurística PT-BR aproximada (1 token ≈ 4 chars)

/**
 * Quebra texto em chunks de ~maxTokens com overlap de N tokens entre chunks consecutivos.
 *
 * Estratégia: greedy por caractere (não por sentence boundary). Suficiente pra boletim
 * técnico onde texto é estruturado e qualquer corte preserva semântica razoável.
 * Se for processar texto narrativo longo (caso/case), iterar pra split por sentença
 * em versão futura (refinamento, não bloqueante).
 */
export function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  if (!text || text.length === 0) return [];

  const maxChars = opts.maxTokens * CHARS_PER_TOKEN;
  const overlapChars = opts.overlap * CHARS_PER_TOKEN;
  const stepChars = Math.max(1, maxChars - overlapChars);

  // Caso pequeno: 1 chunk só
  if (text.length <= maxChars) {
    return [{
      content: text,
      charStart: 0,
      charEnd: text.length,
      tokenEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
    }];
  }

  const chunks: Chunk[] = [];
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + maxChars, text.length);
    const content = text.slice(pos, end);
    chunks.push({
      content,
      charStart: pos,
      charEnd: end,
      tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
    });
    if (end >= text.length) break;
    pos += stepChars;
  }

  return chunks;
}
