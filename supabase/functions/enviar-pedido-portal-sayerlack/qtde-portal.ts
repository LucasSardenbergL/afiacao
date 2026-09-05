// Conversão da quantidade do pedido (unidade do Omie) para a unidade que o portal Sayerlack aceita.
//
// `fator_conversao` (sku_fornecedor_externo) = unidades do PORTAL por unidade do OMIE.
//   - fator 1  → mesma unidade (padrão; concentrados QT/GL já saem do motor em embalagens);
//   - fator 0,2 → Omie em LITRO, portal em BALDE de 5 L (TINGIMIX TEH.3505.00BB: 36 L → 8 BB).
//
// O portal só aceita inteiros → arredonda SEMPRE para cima (nunca sub-pedir). O `round6` antes do
// `ceil` mata a poeira binária de `q * f` (ex.: 0,2 não é exato em IEEE-754): sem ele um múltiplo
// exato pode virar 7,000000000000001 → ceil 8 → um balde a mais no fornecedor, sem desfazer.
//
// Fail-CLOSED: fator não-finito ou ≤ 0 lança — o chamador aborta o envio do pedido INTEIRO
// (efeito irreversível: o fornecedor recebe de verdade). Antes, `Math.max(1, NaN)` = NaN ia parar
// no input do portal como texto "NaN".

export class FatorConversaoInvalidoError extends Error {
  constructor(readonly fator: unknown, readonly sku: string) {
    super(`fator_conversao inválido (${String(fator)}) para ${sku} — corrija em sku_fornecedor_externo`);
    this.name = "FatorConversaoInvalidoError";
  }
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export function qtdePortal(qtdeFinal: number, fator: number, sku = "?"): number {
  if (!(Number.isFinite(fator) && fator > 0)) throw new FatorConversaoInvalidoError(fator, sku);
  const q = Number(qtdeFinal);
  if (!Number.isFinite(q)) throw new FatorConversaoInvalidoError(`qtde_final=${String(qtdeFinal)}`, sku);
  return Math.max(1, Math.ceil(round6(q * fator)));
}
