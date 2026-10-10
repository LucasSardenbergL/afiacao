// ATP fase 3.3 — os dois furos do envio ao Omie que a 3.1 deixou (Codex retroativo #1/#3).
// PURO (zero Deno/DB): provado por `deno test --no-remote supabase/functions/_shared/atp-pv-omie_test.ts`.
//
// #1 — reenvio reconciliado por duplicidade. A chave `PV_<sales_order_id>` é determinística:
//   se o write-back falhou depois de o PV nascer e o vendedor mudou o carrinho, o reenvio bate
//   duplicata e a edge VINCULA o PV antigo, com os itens da tentativa anterior. A RPC
//   `atp_confirmar_pv` (migration 20261010150000) ajusta a reserva ao PV na mesma transação do
//   write-back e devolve `pv_divergente`/`pv_itens_legiveis`; aqui se decide o que o vendedor ouve.
//
// #3 — exclusão antes da confirmação. Pedido Oben sem `omie_pedido_id` local pode ter PV vivo no
//   Omie (o write-back é que falhou). Apagar a linha soltava a reserva (FK SET NULL → TTL) com o
//   PV vivo. A mesma chave determinística é o registro durável do envio: a edge consulta o Omie
//   por ela antes de apagar. Aqui se classifica a resposta — ambiguidade NUNCA vira "não existe".

/** Mensagem a LANÇAR depois de um write-back reconciliado, ou `null` quando o PV bate com a
 *  reserva. Lança (não `success` com aviso): caller antigo ignora campo desconhecido e o
 *  vendedor acharia que o carrinho ATUAL foi ao Omie. O vínculo já está gravado, então o
 *  reenvio seguinte é recusado pelo guard de reenvio — a mensagem manda conferir, não reenviar. */
export function avisoPvReconciliado(wb: unknown, omiePedidoId: number): string | null {
  const r = (wb ?? {}) as { pv_divergente?: unknown; pv_itens_legiveis?: unknown };
  if (r.pv_divergente === true) {
    return `O pedido já existia no Omie (PV ${omiePedidoId}) com os itens de uma tentativa anterior, ` +
      `diferentes do carrinho atual. O pedido foi vinculado e a reserva de estoque passou a ser a do ` +
      `pedido do Omie. Confira o pedido no Omie e, se o carrinho atual é o certo, corrija pela edição ` +
      `do pedido — não reenvie.`;
  }
  if (r.pv_itens_legiveis === false) {
    return `O pedido já existia no Omie (PV ${omiePedidoId}), mas não deu para conferir os itens dele. ` +
      `O pedido foi vinculado; confira no Omie se os itens batem com o carrinho — não reenvie.`;
  }
  return null;
}

/** Resultado da consulta do PV pela chave de integração antes de excluir. */
export type ConsultaExclusao =
  | { tipo: "ausente" }
  | { tipo: "existe"; codigoPedido: number }
  | { tipo: "indeterminado"; detalhe: string };

/** Resposta do ConsultarPedido chamado com `throwOnTransient`. `null` ali só sai do EOF do
 *  contrato ("Não existem registros") — o transitório esgotado LANÇA. */
export function classificarConsultaExclusao(resultado: unknown): ConsultaExclusao {
  if (resultado === null) return { tipo: "ausente" };
  const r = resultado as {
    pedido_venda_produto?: { cabecalho?: { codigo_pedido?: unknown } };
    cabecalho?: { codigo_pedido?: unknown };
  };
  const cod = (r?.pedido_venda_produto?.cabecalho ?? r?.cabecalho)?.codigo_pedido;
  if (typeof cod === "number" && Number.isInteger(cod) && cod > 0) {
    return { tipo: "existe", codigoPedido: cod };
  }
  return { tipo: "indeterminado", detalhe: `resposta sem codigo_pedido válido (${JSON.stringify(cod ?? null)})` };
}

// Fault de negócio que afirma AUSÊNCIA. "já cadastrado" (duplicata) não casa: exige o "não".
const NAO_ENCONTRADO = /n[aã]o (cadastrad|encontrad|existe)/i;

/** Erro do ConsultarPedido: só o fault que afirma ausência vira "ausente". Transitório,
 *  HTTP, fault desconhecido ⇒ indeterminado (a exclusão é recusada). */
export function classificarErroConsultaExclusao(e: unknown): ConsultaExclusao {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.startsWith("OMIE_TRANSIENT") && NAO_ENCONTRADO.test(msg)) return { tipo: "ausente" };
  return { tipo: "indeterminado", detalhe: msg };
}
