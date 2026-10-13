// Negociação de uma linha COM COR depois que ela já está no carrinho (Fase 2B).
//
// O gate da fronteira (`tint_gate_revalida`) recomputa o preço a partir da decisão
// declarada no item: fonte (calculado|tabela|cliente) + desconto ⇒ o preço cobrado tem
// de ser `arred(partida × (1 − d/100))` ao centavo. Editar só `unit_price` deixava fonte
// e desconto ANTIGOS — o gate recusava no envio ("remova e adicione de novo"). Aqui toda
// edição regrava a decisão INTEIRA (preço, desconto, preço de partida) com a MESMA
// aritmética do seletor (`aplicarDesconto`), ou recusa NA HORA com o motivo.
//
// Regras (money-path, fail-closed):
// - Partida confiável: só fonte de seletor (calculado|tabela|cliente) com fórmula. Sem o
//   preço de partida gravado, ele só é deduzível quando o desconto é 0 (aí partida = preço).
// - Desconto no domínio do gate: 0 ≤ d < 100. Sem teto comercial (decisão do founder).
// - Preço final > 0 depois do arredondamento (`precoVendavel`): nunca R$ 0.
// - Preço ACIMA da partida é recusado: a fonte não admite desconto negativo, e trocar
//   para 'manual' dependeria do piso do servidor, que o carrinho não conhece.
import { aplicarDesconto, precoVendavel } from './pode-adicionar';

/** Fontes que o seletor declara e o gate recomputa por fórmula. */
const FONTES_DE_SELETOR = new Set(['calculado', 'tabela', 'cliente']);

/** O que a negociação lê de uma linha do carrinho (estrutural — vale para ProductCartItem). */
export interface LinhaTintNegociavel {
  unit_price: number;
  tint_formula_id?: string;
  tint_price_source?: string;
  tint_discount_pct?: number;
  tint_preco_sem_desconto?: number;
}

/** Decisão coerente para gravar na linha (os 3 campos SEMPRE juntos). */
export interface DecisaoTint {
  unit_price: number;
  tint_discount_pct: number;
  tint_preco_sem_desconto: number;
}

export type Renegociacao = { ok: true; decisao: DecisaoTint } | { ok: false; motivo: string };

const SEM_PARTIDA =
  'Esta cor não tem preço de partida confiável no carrinho. Remova a linha e adicione a cor de novo para negociar.';

/** Preço da fonte, sem desconto — a base de qualquer renegociação. `null` = não negociável. */
export function precoDePartida(item: LinhaTintNegociavel): number | null {
  if (!item.tint_formula_id) return null;
  if (!item.tint_price_source || !FONTES_DE_SELETOR.has(item.tint_price_source)) return null;
  if (item.tint_preco_sem_desconto != null) {
    return precoVendavel(item.tint_preco_sem_desconto) ? item.tint_preco_sem_desconto : null;
  }
  // Sem a partida gravada, só dá para deduzi-la quando não houve desconto (preço = partida).
  return (item.tint_discount_pct ?? 0) === 0 && precoVendavel(item.unit_price) ? item.unit_price : null;
}

/** Novo desconto % sobre a partida da linha. */
export function renegociarPorDesconto(item: LinhaTintNegociavel, descontoPct: number): Renegociacao {
  if (!Number.isFinite(descontoPct) || descontoPct < 0 || descontoPct >= 100) {
    return { ok: false, motivo: 'Desconto precisa ficar entre 0% e 99,99%.' };
  }
  const partida = precoDePartida(item);
  if (partida == null) return { ok: false, motivo: SEM_PARTIDA };
  const preco = aplicarDesconto(partida, descontoPct);
  if (!precoVendavel(preco)) {
    return { ok: false, motivo: 'Com esse desconto o preço da cor fica R$ 0,00. Use um desconto menor.' };
  }
  return { ok: true, decisao: { unit_price: preco, tint_discount_pct: descontoPct, tint_preco_sem_desconto: partida } };
}

/** Novo preço unitário: vira o desconto equivalente sobre a partida (mesma fonte). */
export function renegociarPorPreco(item: LinhaTintNegociavel, preco: number): Renegociacao {
  if (!Number.isFinite(preco)) return { ok: false, motivo: 'Preço inválido.' };
  const centavos = Math.round(preco * 100) / 100;
  if (!precoVendavel(centavos)) return { ok: false, motivo: 'O preço da cor precisa ser maior que R$ 0,00.' };
  const partida = precoDePartida(item);
  if (partida == null) return { ok: false, motivo: SEM_PARTIDA };
  if (centavos > partida + 0.005) {
    return {
      ok: false,
      motivo: `O preço desta cor parte de ${brl(partida)}: no carrinho dá para dar desconto, não para subir. Para outro preço, remova a linha e escolha a cor de novo.`,
    };
  }
  const descontoPct = centavos >= partida ? 0 : (1 - centavos / partida) * 100;
  // Prova de ida e volta: o gate recomputa o preço a partir do desconto declarado. Se a
  // aritmética de ponto flutuante não devolver o centavo digitado, recusa (nunca envia
  // um par preço×desconto que o servidor rejeitaria).
  const recomputado = aplicarDesconto(partida, descontoPct);
  if (descontoPct >= 100 || Math.abs(recomputado - centavos) > 0.005) {
    return { ok: false, motivo: 'Não consegui converter esse preço num desconto exato. Ajuste pelo campo de desconto.' };
  }
  return { ok: true, decisao: { unit_price: centavos, tint_discount_pct: descontoPct, tint_preco_sem_desconto: partida } };
}

/** Desconto do PEDIDO: o mesmo % em TODAS as linhas com cor, tudo-ou-nada. Uma linha que
 *  não aceita (sem partida, R$ 0) recusa o lote inteiro com o motivo por cor — aplicar em
 *  parte deixaria a vendedora achando que o pedido todo levou o desconto. Linhas sem cor
 *  passam intactas (o preço delas é negociado item a item, com Régua/cockpit). */
export function aplicarDescontoNasCores<T extends LinhaTintNegociavel & { tint_cor_id?: string }>(
  linhas: T[],
  descontoPct: number,
): { ok: true; linhas: T[]; aplicadas: number } | { ok: false; falhas: Array<{ cor: string; motivo: string }> } {
  const falhas: Array<{ cor: string; motivo: string }> = [];
  let aplicadas = 0;
  const novas = linhas.map((l) => {
    if (!l.tint_cor_id) return l;
    const r = renegociarPorDesconto(l, descontoPct);
    if (!r.ok) {
      falhas.push({ cor: l.tint_cor_id, motivo: r.motivo });
      return l;
    }
    aplicadas++;
    return { ...l, ...r.decisao };
  });
  if (falhas.length > 0) return { ok: false, falhas };
  return { ok: true, linhas: novas, aplicadas };
}

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
