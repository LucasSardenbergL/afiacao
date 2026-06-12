// Reposição — "a caminho" (estoque_pendente_entrada) derivado dos PEDIDOS DE COMPRA do Omie.
// ============================================================================================
// PROBLEMA (confirmado em prod 2026-06-11): a fonte atual de estoque_pendente_entrada é o método
// Omie `ListarSaldoPendente` (tipo=ENTRADA), que devolve só a pendência "atual/vencida" e EXCLUI a
// previsão futura de PO aprovada. Caso real: PO 1054 (aprovada, entrega 19/06, FUNDO PU 3un) NÃO
// aparece no ListarSaldoPendente, então o motor re-sugere comprar o que já está pedido (double-buy).
//
// DESENHO v1 (eu, Caminho B — Codex no adversarial retroativo):
//   estoque_efetivo (RPC) = estoque_fisico + estoque_pendente_entrada + em_transito.
//   - em_transito (CTE da RPC): POs disparadas PELO APP (tabela interna pedido_compra_sugerido). FICA.
//   - estoque_pendente_entrada (esta lógica, escrita pela edge): passa a ser as POs do Omie que NÃO
//     são contadas pelo em_transito = POs MANUAIS abertas-aprovadas. Some (qtde - recebido) por SKU.
//   => app POs via em_transito · manual POs via esta fonte · sem double-count · previsão futura entra.
//
// DE-DUP EXATO (a parte sutil — marcada p/ challenge do Codex): o conjunto de exclusão NÃO é "todas as
// POs do app", e sim "as POs que o em_transito DE FATO conta" (mesma janela/status que a CTE). Assim:
//   - PO recente do app  -> em_transito conta E está no de-dup -> NÃO entra aqui (sem double-count).
//   - PO antiga do app (fora da janela de 7d do em_transito) e ainda ABERTA no Omie -> NÃO está no
//     de-dup -> entra aqui (sem o "buraco de 7d" que apareceria se excluíssemos todas as POs do app).
// A edge monta `poNumerosEmTransito` com o MESMO predicado da CTE em_transito (status + janela).
//
// Por que (qtde - recebido) e não a qtde cheia: o que já foi recebido vira estoque_fisico (o sync de
// físico pega). Contar só o saldo a receber evita double-count com o físico. recebido>=qtde => 0.
//
// NÃO-OBJETIVOS v1 (registrados p/ Codex/v2): (a) aposentar o em_transito e ter a PO do Omie como
// FONTE ÚNICA (mais limpo, sem de-dup, mas aposta na completude do sync de PO -> risco de ruptura se
// o sync sub-contar; v2 quando o sync de PO estiver provado completo + bump-on-dispatch); (b) PO do
// app com omie_pedido_compra_numero NULL no meio do disparo (janela de segundos) -> de-dup não pega
// -> double-count transitório raro.

export interface PoItemOmie {
  /** sku_codigo_omie (nCodProd do Omie), como string. */
  sku: string;
  /** Número do pedido de compra no Omie (cNumero) — chave de de-dup com o em_transito. */
  poNumero: string;
  /** cEtapa do pedido (códigos CUSTOMIZÁVEIS por conta — o mapa vem da sondagem). */
  etapa: string;
  /** nQtde do item. */
  qtde: number;
  /** nQtdeRec do item (recebido). */
  recebido: number;
}

export interface PendenteEntradaOpts {
  /** Etapas que significam APROVADO-E-ABERTO (exclui "em aprovação", recebido, cancelado). Da sondagem. */
  etapasAbertas: ReadonlySet<string>;
  /** Números de PO do Omie que o em_transito JÁ conta (mesmo status+janela da CTE) — de-dup exato. */
  poNumerosEmTransito: ReadonlySet<string>;
}

/** Saldo a receber de um item (nunca negativo). */
export function saldoAReceber(qtde: number, recebido: number): number {
  const q = Number.isFinite(qtde) ? qtde : 0;
  const r = Number.isFinite(recebido) ? recebido : 0;
  return Math.max(0, q - r);
}

/** True se o item deve entrar em estoque_pendente_entrada (aberto-aprovado, manual, com saldo). */
export function itemContaComoPendente(item: PoItemOmie, opts: PendenteEntradaOpts): boolean {
  if (!opts.etapasAbertas.has(item.etapa)) return false; // não-aprovado / recebido / cancelado
  if (opts.poNumerosEmTransito.has(item.poNumero)) return false; // já contado pelo em_transito
  return saldoAReceber(item.qtde, item.recebido) > 0;
}

/**
 * Soma o "a caminho" (saldo a receber) por SKU sobre as POs MANUAIS abertas-aprovadas do Omie.
 * Resultado vira estoque_pendente_entrada (a edge grava em sku_estoque_atual).
 */
export function computePendenteEntradaPorSku(
  items: readonly PoItemOmie[],
  opts: PendenteEntradaOpts,
): Map<string, number> {
  const porSku = new Map<string, number>();
  for (const item of items) {
    if (!itemContaComoPendente(item, opts)) continue;
    const add = saldoAReceber(item.qtde, item.recebido);
    porSku.set(item.sku, (porSku.get(item.sku) ?? 0) + add);
  }
  return porSku;
}
