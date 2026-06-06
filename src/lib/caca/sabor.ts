/**
 * Classificação de sabor do candidato à caça.
 *
 * Precedência (da mais alta pra mais baixa):
 *   1. compraNaEmpresaAlvo → null (não é candidato)
 *   2. compraEmOutraEmpresa (e não na alvo) → cross_empresa
 *   3. ultimaCompraGrupoDias >= dormenteMeses*30 → dormente
 *   4. ultimaCompraGrupoDias == null → frio
 *   5. ultimaCompraGrupoDias > 0 mas abaixo do corte → null
 *      (comprou recentemente fora da alvo, não se encaixa numa categoria produtiva de caça)
 *
 * Helper PURO — sem IO, sem imports externos.
 */

import type { CandidatoFeatures, SaborCaca } from './types';

/**
 * Classifica o sabor de caça do candidato.
 * Retorna null quando o candidato não é válido para caça:
 *   - já compra na empresa-alvo, OU
 *   - comprou recentemente no grupo mas não na alvo e não é cross (ativo no grupo)
 */
export function classificarSabor(
  c: CandidatoFeatures,
  dormenteMeses = 6,
): SaborCaca | null {
  // Já compra na empresa-alvo → não é candidato
  if (c.compraNaEmpresaAlvo) return null;

  // Cross: compra em outra empresa do grupo mas não na alvo
  if (c.compraEmOutraEmpresa) return 'cross_empresa';

  // Dormente: última compra no grupo >= corte
  const corteDias = dormenteMeses * 30;
  if (c.ultimaCompraGrupoDias !== null && c.ultimaCompraGrupoDias >= corteDias) {
    return 'dormente';
  }

  // Frio: nunca comprou nada no grupo
  if (c.ultimaCompraGrupoDias === null) return 'frio';

  // Comprou recentemente no grupo (< corte) mas não na alvo e não é cross:
  // não é um candidato produtivo para caça agora
  return null;
}
