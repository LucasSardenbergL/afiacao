/**
 * Classificação de estado de uma opção de venda assistida — Fatia 1.
 *
 * Estados (design §4 da spec do programa):
 *   - SELLABLE_NOW   — base mapeada + precificada + DISPONÍVEL, e o catalisador obrigatório
 *                      também mapeado + em estoque. "Melhor opção em estoque hoje."
 *   - ORDERABLE      — mapeado mas não tudo disponível/precificável agora → sob encomenda.
 *   - TECHNICAL_ONLY — sem SKU confirmado (sem casamento) → alternativa técnica, "sob consulta".
 *
 * Regras confirmadas pelo founder (2026-06-14): "em estoque agora" exige base E catalisador
 * em estoque. Codex (P0): SELLABLE_NOW exige PRECIFICADO (preço confiável) — sem preço não promete.
 */

export type EstadoVenda = 'SELLABLE_NOW' | 'ORDERABLE' | 'TECHNICAL_ONLY';

export interface DisponibilidadeInput {
  /** Existe vínculo boletim↔SKU confirmado pra a base (casamento). */
  temSkuConfirmado: boolean;
  /** Alguma embalagem da base com saldo > 0. */
  baseEmEstoque: boolean;
  /** O boletim exige catalisador (catalisador_proporcao_pct > 0). */
  precisaCatalisador: boolean;
  /** O catalisador tem SKU confirmado (casamento do catalisador). */
  catalisadorMapeado: boolean;
  /** Alguma embalagem do catalisador com saldo > 0. */
  catalisadorEmEstoque: boolean;
  /** O motor de preço retornou status 'ok' (preço confiável, não "sob consulta"). */
  precoOk: boolean;
}

export function classificarEstadoVenda(d: DisponibilidadeInput): EstadoVenda {
  // Sem casamento → não há produto vendável; só alternativa técnica.
  if (!d.temSkuConfirmado) return 'TECHNICAL_ONLY';

  // Catalisador obrigatório precisa estar mapeado E em estoque; se não é obrigatório, ok.
  const catalisadorOk = !d.precisaCatalisador || (d.catalisadorMapeado && d.catalisadorEmEstoque);

  // "Em estoque agora" exige tudo disponível E precificado (Codex P0).
  if (d.baseEmEstoque && catalisadorOk && d.precoOk) return 'SELLABLE_NOW';

  // Mapeado mas não tudo disponível/precificável → encomenda.
  return 'ORDERABLE';
}
