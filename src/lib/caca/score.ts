/**
 * Cálculo de score de aderência de um candidato ao perfil dos melhores.
 *
 * Fórmula de score:
 *   Para cada dimensão COM DADO, calcula uma "aderência" (0..tetoLift ou mais).
 *   O score final = MÉDIA das aderências das dimensões usadas.
 *   Usar média (não soma) garante comparabilidade independente do nº de dimensões:
 *   um candidato com 1 dimensão perfeita ≠ um com 4 dimensões mediocres.
 *
 * Aderência por dimensão:
 *   - regiao:   regiaoLift[cidadeUf] se existir, senão 1 (neutro — cidade conhecida mas sem lift)
 *   - ramo:     ramoLift[ramo] se existir, senão 1; ramo=null → AUSENTE (não zero)
 *   - ticket:   proximidade relativa ao ticketMediano; decai com distância; null → AUSENTE
 *   - familias: média dos familiaLift das famílias do candidato; [] → AUSENTE
 *
 * Confiança = dimensoesUsadas.length / 4 (0..1).
 *
 * Helper PURO — sem IO, sem imports externos.
 */

import type { CandidatoFeatures, DimensaoCaca, PerfilMelhores } from './types';

interface ScoreResult {
  score: number;
  confianca: number;
  dimensoesUsadas: DimensaoCaca[];
}

/**
 * Proximidade de ticket: 1 quando igual ao mediano, decai conforme a distância relativa.
 * Usa a fórmula 1 / (1 + |relativo|) onde relativo = (ticket - mediano) / mediano.
 * Garante que score = 1 quando igual e decai monotonicamente com a distância.
 */
function aderenciaTicket(ticketFaixa: number, ticketMediano: number): number {
  if (ticketMediano <= 0) return 1; // mediano inválido → neutro
  const distRelativa = Math.abs(ticketFaixa - ticketMediano) / ticketMediano;
  return 1 / (1 + distRelativa);
}

/**
 * Calcula o score de aderência do candidato ao perfil dos melhores.
 * Candidatos com mais dimensões disponíveis têm maior confiança,
 * mas o score (aderência média) é comparável independentemente do nº de dimensões.
 */
export function scoreCandidato(c: CandidatoFeatures, perfil: PerfilMelhores): ScoreResult {
  const dimensoesUsadas: DimensaoCaca[] = [];
  const aderencias: number[] = [];

  // Dimensão: regiao
  // Conta se cidadeUf está presente. Lift neutro (1) se cidade não consta no perfil.
  if (c.cidadeUf !== null) {
    dimensoesUsadas.push('regiao');
    const lift = perfil.regiaoLift[c.cidadeUf] ?? 1;
    aderencias.push(lift);
  }

  // Dimensão: ramo
  // Ausência (null) = sem dado. NÃO é lift zero.
  if (c.ramo !== null) {
    dimensoesUsadas.push('ramo');
    const lift = perfil.ramoLift[c.ramo] ?? 1;
    aderencias.push(lift);
  }

  // Dimensão: ticket
  // Ausência (null) = sem histórico.
  if (c.ticketFaixa !== null && perfil.ticketMediano !== null) {
    dimensoesUsadas.push('ticket');
    aderencias.push(aderenciaTicket(c.ticketFaixa, perfil.ticketMediano));
  } else if (c.ticketFaixa !== null && perfil.ticketMediano === null) {
    // ticket conhecido mas sem mediano no perfil → neutro (conta como dimensão com lift 1)
    dimensoesUsadas.push('ticket');
    aderencias.push(1);
  }

  // Dimensão: familias
  // Ausência ([]) = frio, sem histórico de compra.
  if (c.familias.length > 0) {
    dimensoesUsadas.push('familias');
    const lifts = c.familias.map((f) => perfil.familiaLift[f] ?? 1);
    const mediaLifts = lifts.reduce((acc, l) => acc + l, 0) / lifts.length;
    aderencias.push(mediaLifts);
  }

  // Score = média das aderências (comparável entre candidatos com diferentes nº de dimensões)
  const score =
    aderencias.length > 0
      ? aderencias.reduce((acc, a) => acc + a, 0) / aderencias.length
      : 0;

  const confianca = dimensoesUsadas.length / 4;

  return { score, confianca, dimensoesUsadas };
}
