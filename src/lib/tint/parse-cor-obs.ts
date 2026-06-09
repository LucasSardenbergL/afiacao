/**
 * Extrai a cor da observação do item vinda do Omie.
 *
 * Na venda, o submit grava a cor como `obs_item`/`dados_adicionais_item` no
 * formato `"Cor: <label> - <embalagem>"` (ex.: `"Cor: 1247 - AZUL RAL 5010 - QT"`,
 * onde `<label>` = `"<cor_id> - <nome>"` ou só `"<nome>"`). Aqui fazemos o
 * caminho inverso ao sincronizar o pedido de volta do Omie, para remontar
 * `tint_nome_cor` no jsonb `sales_orders.items` (que o sync hoje descarta).
 *
 * Conservador (de propósito):
 * - só reconhece o prefixo `Cor:` (case-insensitive);
 * - remove o sufixo de embalagem conhecido (QT/GL/LT/<n>ML) só quando no FIM e
 *   precedido de `" - "` — nunca quebra o nome da cor (que pode ter hífen);
 * - mantém o label inteiro (código + nome) em `tint_nome_cor`, que já é legível;
 * - retorna `null` quando não há cor (item comum / ordem de compra) — degradação
 *   honesta, sem fabricar.
 *
 * ⚠️ Espelhado VERBATIM no edge `supabase/functions/omie-vendas-sync/index.ts`
 * (Deno não importa de `src/`). Mantenha os dois em sincronia.
 */
export interface CorParseada {
  tint_nome_cor: string;
}

export function parseCorObs(obs: string | null | undefined): CorParseada | null {
  if (!obs) return null;
  const m = /^\s*cor:\s*(.+)$/i.exec(obs);
  if (!m) return null;
  const label = m[1].replace(/\s*-\s*(?:QT|GL|LT|\d+(?:[.,]\d+)?\s*ML)\s*$/i, '').trim();
  if (!label) return null;
  return { tint_nome_cor: label };
}
