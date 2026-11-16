// Orçamento da espera entre FILHOS de split Sayerlack/OBEN (PR8/PR10).
//
// Por quê (2026-11-16, split #4421 → #4425/#4426): a edge esperava até 90 s por filho, em série,
// dentro do limite de 150 s da Supabase Edge (IDLE_TIMEOUT). Dois filhos bastaram para o 504 —
// o disparo terminou (portal + Omie), mas a tela mostrou erro. A espera só serializa o Browserless
// (o plano atual aceita 10 concorrentes), então, esgotado o orçamento, seguimos SEM esperar:
// melhor um envio concorrente do que uma resposta que nunca chega.

/** Espera máxima por filho (a do PR8). */
export const ESPERA_MAX_POR_FILHO_MS = 90_000;

/**
 * Teto de espera SOMADA na execução, contado do início do request. Deixa ~50 s dos 150 s para o
 * processamento dos filhos restantes, os e-mails e a resposta.
 */
export const ORCAMENTO_ESPERA_TOTAL_MS = 100_000;

/** Abaixo disso não vale abrir o polling (intervalo de 3 s). */
const ESPERA_MINIMA_MS = 3_000;

/**
 * Quantos ms ainda podemos esperar por este filho. 0 = não espere, siga.
 * `inicioMs`/`agoraMs` em epoch ms; relógio inválido → 0 (nunca arrisca o 504).
 */
export function esperaPermitidaMs(inicioMs: number, agoraMs: number): number {
  if (!Number.isFinite(inicioMs) || !Number.isFinite(agoraMs)) return 0;
  const restante = inicioMs + ORCAMENTO_ESPERA_TOTAL_MS - agoraMs;
  const espera = Math.min(ESPERA_MAX_POR_FILHO_MS, restante);
  return espera >= ESPERA_MINIMA_MS ? espera : 0;
}
