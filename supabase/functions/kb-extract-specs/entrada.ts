// Entrada do prompt de extração: o texto do boletim vai INTEIRO ou não vai.
//
// Antes era `content_extracted.slice(0, 50_000)` — o fim do boletim sumia em silêncio, o modelo
// devolvia `tool_use` normal e o draft virava `ready` com specs ausentes que pareciam "o boletim
// não informa" (ausente ≠ completo, docs/agent/money-path.md §2). Agora quem passa do limite
// EXCEDE e não carrega recorte nenhum: o caller não tem como mandar meio boletim para o modelo.
//
// O limite é o herdado e NÃO foi mexido de propósito: medido em prod (2026-10-05, psql-ro) o maior
// dos 297 boletins tem 14.644 chars (p99 14.464), ~3,4× abaixo. Se um dia um boletim exceder,
// o draft falha dizendo isso — aí a decisão (subir o limite / várias passadas) se toma com o caso
// na mão.
export const LIMITE_ENTRADA_CHARS = 50_000;

export type EntradaBoletim =
  | { excede: false; texto: string }
  | { excede: true; tamanho: number; motivo: string };

export function avaliarEntradaBoletim(texto: string): EntradaBoletim {
  if (texto.length <= LIMITE_ENTRADA_CHARS) return { excede: false, texto };
  return {
    excede: true,
    tamanho: texto.length,
    motivo: `entrada truncada: boletim com ${texto.length} chars passa do limite de ${LIMITE_ENTRADA_CHARS} do prompt — extração recusada para não salvar spec parcial`,
  };
}
