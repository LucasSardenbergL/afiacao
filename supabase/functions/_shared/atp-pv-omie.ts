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

// PR 2.5 (rodada 3, "reenvio honesto") — a PREVISÃO DE ENTREGA. A data prometida vai em
// `frete.previsao_entrega` (PR 2.3). Se o carrinho do reenvio trocou a data, o PV vinculado ficou com a
// da tentativa anterior e o vendedor acharia que a data nova foi. Doc do Omie (pedido_venda_produto →
// frete): `previsao_entrega`, string10, "Previsão de entrega do Pedido de Venda", formato NÃO
// documentado — e não há ConsultarPedido real em prod para conferir (0 `sales_orders` com
// `omie_response.consulta` em 2026-11-24).
// Régua (cortada ao núcleo em 2 rodadas do Codex no #4174 — precisão > recall, money-path §1):
//   - DIVERGENTE só com PROVA: este envio leva data legível E o PV traz outra data legível, ou o campo
//     PRESENTE e vazio (o PV não tem data);
//   - campo ausente, texto ilegível, envio SEM data, ou PV sem `cabecalho` = NÃO CONFERÍVEL (nunca
//     "igual");
//   - comparação e payload gravado leem o MESMO objeto da consulta (`pvDaConsulta`) e exigem o mesmo
//     `cabecalho` (Codex r2: frete de um objeto sem cabecalho dava "igual" com payload null).
// O que a divergência FAZ (decisão do founder 2026-11-25, depois do Codex r2): só AVISA — `aviso_previsao`
// no resultado do `criar_pedido` + log, SEM lançar. Lançar pulava a OP da Colacor (o front não cria a OP
// num envio com erro, e o clique seguinte cai em "já enviado"); a main concluía. O espelho na tela fica
// para a Onda 3 com o front do 2.5. A verdade fica gravada: `omie_payload` = o PV do Omie.

/** O PV dentro da resposta do ConsultarPedido: `pedido_venda_produto` quando é objeto, senão a raiz
 *  quando ela tem `cabecalho`; `null` sem forma reconhecível. Única fonte do frete e do payload. */
function pvDaConsulta(consulta: unknown): Record<string, unknown> | null {
  const c = consulta as { pedido_venda_produto?: unknown; cabecalho?: unknown } | null;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const pvp = c.pedido_venda_produto;
  if (pvp !== undefined) return pvp && typeof pvp === "object" && !Array.isArray(pvp) ? pvp as Record<string, unknown> : null;
  return c.cabecalho && typeof c.cabecalho === "object" ? c as Record<string, unknown> : null;
}

/** Dia de calendário `aaaa-mm-dd` de um texto dd/mm/aaaa ou aaaa-mm-dd; `null` se ilegível. */
function diaDaPrevisao(v: string): string | null {
  const s = v.trim();
  let a: number, m: number, d: number;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (br) [d, m, a] = [Number(br[1]), Number(br[2]), Number(br[3])];
  else if (iso) [a, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else return null;
  const dt = new Date(Date.UTC(a, m - 1, d));
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(a).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export type ComparacaoPrevisao =
  | { estado: "igual" }
  /** `noOmie` null = o PV não tem previsão de entrega (campo presente e vazio). */
  | { estado: "divergente"; noOmie: string | null; enviada: string }
  | { estado: "nao_conferivel" };

/** A previsão de entrega do PV vinculado é a deste envio? `enviada` é o valor que foi no payload
 *  (`previsaoEntregaOmie`, dd/mm/aaaa) ou null/"" quando este envio não promete data. */
export function compararPrevisaoEntregaPv(enviada: string | null | undefined, consulta: unknown): ComparacaoPrevisao {
  const envTxt = typeof enviada === "string" ? enviada.trim() : "";
  const diaEnv = envTxt === "" ? null : diaDaPrevisao(envTxt);
  if (diaEnv === null) return { estado: "nao_conferivel" };
  const pv = pvDaConsulta(consulta);
  if (!pv || !pv.cabecalho || typeof pv.cabecalho !== "object" || Array.isArray(pv.cabecalho)) return { estado: "nao_conferivel" };
  const frete = pv.frete;
  if (!frete || typeof frete !== "object" || Array.isArray(frete)) return { estado: "nao_conferivel" };
  if (!Object.prototype.hasOwnProperty.call(frete, "previsao_entrega")) return { estado: "nao_conferivel" };
  const bruto = (frete as { previsao_entrega?: unknown }).previsao_entrega;
  if (typeof bruto !== "string") return { estado: "nao_conferivel" };
  const pvTxt = bruto.trim();
  if (pvTxt === "") return { estado: "divergente", noOmie: null, enviada: envTxt };
  const diaPv = diaDaPrevisao(pvTxt);
  if (diaPv === null) return { estado: "nao_conferivel" };
  return diaPv === diaEnv ? { estado: "igual" } : { estado: "divergente", noOmie: pvTxt, enviada: envTxt };
}

/** O que gravar em `sales_orders.omie_payload` quando o PV foi RECONCILIADO: o pedido que o Omie TEM
 *  (`pedido_venda_produto` do ConsultarPedido — mesma forma do IncluirPedido: cabecalho/det/frete),
 *  nunca o payload deste envio, que o Omie recusou como duplicata. Sem `cabecalho` legível ⇒ `null`
 *  (o mesmo da reconciliação pela exclusão): o `omie_response.consulta` guarda a resposta crua. */
export function payloadDoPvReconciliado(consulta: unknown): Record<string, unknown> | null {
  const pv = pvDaConsulta(consulta);
  return pv && pv.cabecalho && typeof pv.cabecalho === "object" && !Array.isArray(pv.cabecalho) ? pv : null;
}

/** Aviso (NÃO lançado) quando a previsão de entrega do PV reconciliado diverge de forma PROVADA da
 *  deste envio; `null` em igual/não conferível. Vai em `aviso_previsao` no resultado do `criar_pedido`. */
export function avisoPrevisaoEntregaPv(previsao: ComparacaoPrevisao | null, omiePedidoId: number): string | null {
  if (previsao?.estado !== "divergente") return null;
  const noOmie = previsao.noOmie === null ? "SEM previsão de entrega" : `com previsão de entrega ${previsao.noOmie}`;
  return `O pedido já existia no Omie (PV ${omiePedidoId}) ${noOmie}, não com a data deste envio ` +
    `(${previsao.enviada}). Corrija a previsão de entrega direto no Omie — não reenvie.`;
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

/** Exclusão de pedido que JÁ está no Omie (decisão 2026-10-11, founder + Codex): o app NÃO cancela no
 *  ERP. `produtos/pedido/` não tem CancelarPedido (a edge chamava um método inexistente, caía no catch
 *  e apagava só o registro do app); o cancelamento documentado (`pedidovendafat/CancelarPedidoVenda`)
 *  cancela também NF-e e contas a receber de pedido faturado, sem contrato de etapa nem proteção contra
 *  o faturamento concorrente no Omie. Então: registro importado nunca sai pelo app; pedido do app sai
 *  só depois que o sync trouxe o cancelamento feito no Omie. */
export function vereditoExclusaoNoOmie(linha: {
  hashPayload: string | null;
  omiePedidoId: number;
  statusCanonico: string | null;
}): { permitido: true } | { permitido: false; motivo: string } {
  if (typeof linha.hashPayload === "string" && linha.hashPayload.startsWith("omie_")) {
    return {
      permitido: false,
      motivo: `Registro importado do Omie (PV ${linha.omiePedidoId}): registros importados ficam no app, inclusive os cancelados — ele espelha o Omie. Para cancelar o pedido, cancele direto no Omie.`,
    };
  }
  if (linha.statusCanonico === "cancelado") return { permitido: true };
  return {
    permitido: false,
    motivo: `O pedido está no Omie (PV ${linha.omiePedidoId}) e ainda não consta como cancelado aqui. Cancele direto no Omie; quando o sync trouxer o cancelamento, a exclusão é liberada. Se já cancelou e o pedido segue bloqueado depois do próximo sync, avise o suporte (o pedido pode não ter sido importado).`,
  };
}
