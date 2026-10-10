// ATP fase 3.3 — os furos do envio/exclusão no Omie (Codex retroativo da 3.1 #1/#3 e challenge da 3.3).
// PURO (zero Deno/DB): provado por `deno test --no-remote supabase/functions/_shared/atp-pv-omie_test.ts`.
//
// #1 — reenvio reconciliado por duplicidade. A chave `PV_<sales_order_id>` é determinística: se o
//   write-back falhou depois de o PV nascer e o vendedor mudou o carrinho, o reenvio bate duplicata
//   e a edge VINCULA o PV antigo. A RPC `atp_confirmar_pv` (migration 20261010150000) ajusta a
//   RESERVA ao PV; a divergência COMERCIAL (PV × carrinho — existe mesmo sem reserva, no backorder)
//   é decidida aqui, comparando os itens enviados com os do PV.
//
// #3 — exclusão. Pedido Oben sem `omie_pedido_id` local pode ter PV vivo no Omie (o write-back é que
//   falhou). A mesma chave determinística é o registro durável do envio: a edge consulta o Omie por
//   ela antes de apagar e, se o PV existe, recupera o vínculo e RECUSA a exclusão.

import { mensagemDeErro } from "./erro-mensagem.ts";

interface ItemEnviado {
  omie_codigo_produto: number;
  quantidade: number;
}

/** Itens do PV (det do ConsultarPedido) agregados por SKU, ou `null` se QUALQUER item for
 *  ilegível. Mesma régua da RPC: código inteiro positivo, quantidade numérica > 0. */
function itensDoPv(consulta: unknown): Map<number, number> | null {
  const c = consulta as { pedido_venda_produto?: { det?: unknown }; det?: unknown } | null;
  const det = c?.pedido_venda_produto?.det ?? c?.det;
  if (!Array.isArray(det) || det.length === 0) return null;
  const pv = new Map<number, number>();
  for (const e of det) {
    const p = (e as { produto?: { codigo_produto?: unknown; quantidade?: unknown } })?.produto;
    const cod = p?.codigo_produto;
    const qtd = p?.quantidade;
    if (!/^[0-9]{1,18}$/.test(String(cod ?? "")) || Number(cod) <= 0) return null;
    if (typeof qtd !== "number" || !Number.isFinite(qtd) || qtd <= 0) return null;
    pv.set(Number(cod), (pv.get(Number(cod)) ?? 0) + qtd);
  }
  return pv;
}

/** O PV vinculado por duplicidade é o MESMO pedido que o vendedor está enviando agora?
 *  Compara SKU e quantidade agregados (o que o estoque e o faturamento enxergam). */
export function compararCarrinhoPv(enviados: ItemEnviado[], consulta: unknown): "igual" | "divergente" | "ilegivel" {
  const pv = itensDoPv(consulta);
  if (!pv) return "ilegivel";
  const carrinho = new Map<number, number>();
  for (const i of enviados) {
    carrinho.set(i.omie_codigo_produto, (carrinho.get(i.omie_codigo_produto) ?? 0) + i.quantidade);
  }
  if (carrinho.size !== pv.size) return "divergente";
  for (const [sku, qtd] of carrinho) {
    // tolerância de arredondamento de ponto flutuante na soma de linhas fracionárias
    if (!pv.has(sku) || Math.abs((pv.get(sku) ?? 0) - qtd) > 1e-6) return "divergente";
  }
  return "igual";
}

/** Mensagem a LANÇAR depois de um write-back reconciliado, ou `null` quando o PV é o carrinho e a
 *  reserva acompanhou. Lança (não `success` com aviso): caller antigo ignora campo desconhecido e o
 *  vendedor acharia que o carrinho ATUAL foi ao Omie. O vínculo já está gravado, então o reenvio é
 *  recusado pelo guard de reenvio — a mensagem manda conferir, não reenviar.
 *  Duas frases independentes (Codex 3.3, 2ª rodada): o que houve com o PEDIDO (PV × carrinho) e o
 *  que houve com a RESERVA (ajustada, não pôde ser conferida, ou nada a dizer) — uma não esconde a outra. */
export function avisoPvReconciliado(
  comparacao: "igual" | "divergente" | "ilegivel",
  wb: unknown,
  omiePedidoId: number,
): string | null {
  const r = (wb ?? {}) as { ajuste_falhou?: unknown; reserva_ajustada?: unknown };
  const falhou = typeof r.ajuste_falhou === "string" && r.ajuste_falhou !== "";
  const pedido = comparacao === "divergente"
    ? `O pedido já existia no Omie (PV ${omiePedidoId}) com os itens de uma tentativa anterior, diferentes do carrinho atual, e foi vinculado.`
    : comparacao === "ilegivel"
    ? `O pedido já existia no Omie (PV ${omiePedidoId}) e foi vinculado, mas não deu para conferir os itens dele.`
    : null;
  const reserva = falhou
    ? `A reserva de estoque NÃO pôde ser conferida (${r.ajuste_falhou}) — avise o responsável pelo estoque.`
    : r.reserva_ajustada === true
    ? `A reserva de estoque passou a ser a do pedido do Omie.`
    : null;
  if (pedido === null && reserva === null) return null;
  if (pedido === null && !falhou) return null; // PV igual e reserva ajustada a ele: nada a avisar
  const instrucao = comparacao === "divergente"
    ? "Corrija os itens direto no Omie — não reenvie."
    : comparacao === "ilegivel"
    ? "Confira no Omie se os itens batem com o carrinho — não reenvie."
    : "Não reenvie.";
  return [pedido ?? `O pedido já existia no Omie (PV ${omiePedidoId}) e foi vinculado.`, reserva, instrucao]
    .filter(Boolean).join(" ");
}

/** A edição (`alterar_pedido`) não pode partir do carrinho quando o PV vinculado é OUTRO pedido: o
 *  gate de aumento compara local × pedido e liberaria trocar A por B sem reserva (Codex 3.3 P1).
 *  Pedido reconciliado só é editável no app se o PV conferia com os itens gravados. */
export function edicaoBloqueadaPorPvDivergente(
  omieResponse: unknown,
  itensLocais: ItemEnviado[],
): boolean {
  const r = omieResponse as { reconciled?: unknown; consulta?: unknown } | null;
  if (r?.reconciled !== true) return false;
  if (compararCarrinhoPv(itensLocais, r.consulta) !== "igual") return true;
  // Item que o Omie não baixa do estoque (nao_movimentar_estoque = 'S') teve a reserva liberada na
  // reconciliação; a edição recria os itens SEM esse atributo e voltaria a comprometer estoque sem
  // reserva (Codex 3.3, 2ª rodada). Esse pedido também se corrige no Omie.
  const c = r.consulta as { pedido_venda_produto?: { det?: unknown }; det?: unknown } | null;
  const det = c?.pedido_venda_produto?.det ?? c?.det;
  return Array.isArray(det) &&
    det.some((e) => (e as { inf_adic?: { nao_movimentar_estoque?: unknown } })?.inf_adic?.nao_movimentar_estoque === "S");
}

/** Resultado da consulta do PV pela chave de integração antes de excluir. */
export type ConsultaExclusao =
  | { tipo: "ausente" }
  | { tipo: "existe"; codigoPedido: number; consulta: unknown }
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
    return { tipo: "existe", codigoPedido: cod, consulta: resultado };
  }
  return { tipo: "indeterminado", detalhe: `resposta sem codigo_pedido válido (${JSON.stringify(cod ?? null)})` };
}

// Fault de negócio que afirma a AUSÊNCIA DO PEDIDO consultado: exige "pedido" e a negação colada a
// cadastrado/encontrado. "Cliente não cadastrado", "Aplicativo não encontrado" e "Não existem
// permissões" não casam (Codex 3.3 P2) — e "já cadastrado" (duplicata) também não.
const PEDIDO_NAO_ENCONTRADO = /pedido[^.;\n]{0,60}n[aã]o (cadastrad|encontrad)/i;

/** Erro do ConsultarPedido: só o fault que afirma ausência DO PEDIDO vira "ausente". Transitório,
 *  HTTP, fault de outra entidade ou desconhecido ⇒ indeterminado (a exclusão é recusada). */
export function classificarErroConsultaExclusao(e: unknown): ConsultaExclusao {
  const msg = mensagemDeErro(e) ?? "";
  if (!msg.startsWith("OMIE_TRANSIENT") && PEDIDO_NAO_ENCONTRADO.test(msg)) return { tipo: "ausente" };
  return { tipo: "indeterminado", detalhe: msg };
}
