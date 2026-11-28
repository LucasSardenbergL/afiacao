// DRE v1.17 — SINAL POR NATUREZA + linha redutora de CMV (diário: docs/historico/dre-mapa-proprio-nao-resultado.md).
//
// Até a v1.16 o motor somava o valor do título na linha SEM sinal: CR (entrada) numa linha devedora (cmv,
// despesa, dedução, imposto) AUMENTAVA aquele custo. Por isso o mapa de 2026-11-22 mandou devolução de compra
// (1.03.01, CR) para `outras_receitas` em vez de reduzir o CMV (colacor R$ 191k, oben R$ 23k) — a margem bruta
// saía subestimada e o operacional também.
//
// Regra: a linha tem natureza CREDORA (receita) ou DEVEDORA (custo/despesa/dedução/imposto). Título do mesmo
// lado da natureza soma; do lado oposto, SUBTRAI (CR em cmv = devolução de compra; CP em receita = estorno).
// fora_dre/nao_resultado não passam por aqui (seus acumuladores já separam entradas/saídas).
// ESPELHO VERBATIM em src/lib/financeiro/dre-helpers.ts (teste de paridade em dre-helpers.test.ts).

const LINHAS_CREDORAS = new Set<string>(["receita_bruta", "receitas_financeiras", "outras_receitas"]);

/** Valor com sinal da natureza da linha: oposto ao lado do título ⇒ negativo. */
export function valorComSinal(valor: number, isReceita: boolean, linha: string): number {
  return isReceita === LINHAS_CREDORAS.has(linha) ? valor : -valor;
}

/** Contrato VERSIONADO da composição do CMV no `detalhamento` (líquido = compras − devoluções). */
const VERSAO_COMPOSICAO_CMV = "cmv-v1";
export type ComposicaoCmv = { versao: string; compras: number; devolucoes_compra: number; liquido: number };

export function novaComposicaoCmv(): ComposicaoCmv {
  return { versao: VERSAO_COMPOSICAO_CMV, compras: 0, devolucoes_compra: 0, liquido: 0 };
}

/** Só para títulos classificados em `cmv`. Devolução (CR) entra positiva em `devolucoes_compra`. */
export function acumularComposicaoCmv(acc: ComposicaoCmv, valor: number, isReceita: boolean): void {
  if (isReceita) acc.devolucoes_compra += valor;
  else acc.compras += valor;
  acc.liquido = acc.compras - acc.devolucoes_compra;
}
