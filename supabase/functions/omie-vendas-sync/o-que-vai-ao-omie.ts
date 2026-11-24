// O que o PEDIDO DE VENDA leva ao Omie além de produto/quantidade/preço — PR 2.3 da rodada 3 do
// Novo Pedido. Funções PURAS (testadas em o-que-vai-ao-omie_test.ts), usadas pelo `criarPedidoVenda`
// (IncluirPedido), pelo `alterar_pedido` (IncluirItemPedido + AlterarPedidoVenda) e pela
// `criar_ordem_producao` (IncluirOrdemProducao).
//
// 1. COR + OC JUNTAS. Antes, `if (ordemCompra) … else if (cor)`: tinta com ordem de compra saía SEM a
//    cor no item — a NF e a observação do item (que a produção lê para tingir) perdiam a cor. Agora a
//    OC continua inteira em `numero_pedido_compra`, e `dados_adicionais_item` leva as duas.
//    A edição tinha uma CÓPIA da regra que esquecia a embalagem em ML; as duas usam esta.
//
// 2. DATA PROMETIDA. `cabecalho.data_previsao` é, na doc do Omie, "Data de Previsão de FATURAMENTO"
//    (>= hoje, obrigatória) — e o app a usa como o DIA DO ENVIO: fallback do order_date_kpi no sync
//    (sem dInc) e carimbo do sensor `vendas_empurradas_sem_gemeo` (db/2026-11-17-…). Por isso ela NÃO
//    muda; a data prometida vai em `frete.previsao_entrega` ("Previsão de entrega do Pedido de Venda").
//    Na OP, `dDtPrevisao` é a previsão da PRODUÇÃO: a data prometida, ou hoje quando não há.
//    Ausente ≠ hoje: data ausente/ilegível/no passado NÃO vira previsão de entrega — o campo é omitido.

import { paraDataOmie } from "../_shared/hoje-sp.ts";

export interface ItemComCor {
  tint_cor_id?: string | null;
  tint_nome_cor?: string | null;
  descricao?: string | null;
}

/** Embalagem lida da descrição ("… QT", "… GL", "… LT", "… 405ML"); '' quando não há. */
function embalagemDaDescricao(descricao: string | null | undefined): string {
  const d = (descricao || "").toUpperCase();
  if (d.includes(" QT") || d.endsWith("QT")) return "QT";
  if (d.includes(" GL") || d.endsWith("GL")) return "GL";
  if (d.includes(" LT") || d.endsWith("LT")) return "LT";
  const ml = d.match(/(\d+(?:[.,]\d+)?)\s*ML\b/);
  return ml ? ml[1].replace(",", ".") + "ML" : "";
}

/** "Cor: <id> - <nome>[ - <emb>]" do item tintométrico; null quando o item não tem cor. */
export function rotuloCorItem(item: ItemComCor): string | null {
  const id = item.tint_cor_id?.trim();
  const nome = item.tint_nome_cor?.trim();
  if (!id || !nome) return null;
  const corLabel = nome.toUpperCase().includes(id.toUpperCase()) ? nome : `${id} - ${nome}`;
  const emb = embalagemDaDescricao(item.descricao);
  return `Cor: ${corLabel}${emb ? ` - ${emb}` : ""}`;
}

export interface InfoAdicionalItem {
  /** Vai à NF-e do item. */
  dados_adicionais_item?: string;
  /** Nº do pedido de compra do cliente (item). */
  numero_pedido_compra?: string;
  /** Observação do item (a que a produção lê). */
  obs_item?: string;
}

/**
 * Informação adicional de UM item: cor e OC JUNTAS quando há as duas. Vazio ({}) quando não há nenhuma.
 * A OC vai sem rótulo quando está sozinha (é o formato que já ia à NF) e como "OC: <n>" ao lado da cor.
 */
export function infoAdicionalItem(item: ItemComCor, ordemCompra?: string | null): InfoAdicionalItem {
  const oc = typeof ordemCompra === "string" ? ordemCompra.trim() : "";
  const cor = rotuloCorItem(item);
  const r: InfoAdicionalItem = {};
  if (cor && oc) r.dados_adicionais_item = `${cor} | OC: ${oc}`;
  else if (cor) r.dados_adicionais_item = cor;
  else if (oc) r.dados_adicionais_item = oc;
  if (oc) r.numero_pedido_compra = oc;
  if (cor) r.obs_item = cor;
  return r;
}

/** O formato do IncluirPedido: `inf_adic` + `observacao` aninhados (só os que existem). */
export function infoAdicionalItemAninhada(
  item: ItemComCor,
  ordemCompra?: string | null,
): { inf_adic?: Record<string, string>; observacao?: { obs_item: string } } {
  const i = infoAdicionalItem(item, ordemCompra);
  const out: { inf_adic?: Record<string, string>; observacao?: { obs_item: string } } = {};
  const infAdic: Record<string, string> = {};
  if (i.dados_adicionais_item) infAdic.dados_adicionais_item = i.dados_adicionais_item;
  if (i.numero_pedido_compra) infAdic.numero_pedido_compra = i.numero_pedido_compra;
  if (Object.keys(infAdic).length > 0) out.inf_adic = infAdic;
  if (i.obs_item) out.observacao = { obs_item: i.obs_item };
  return out;
}

const DIA_ISO_ESTRITO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` que existe no calendário (rejeita 2026-02-30, 2026-13-01, "2026-1-5", hora junto). */
function diaIsoValido(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = DIA_ISO_ESTRITO.exec(v);
  if (!m) return false;
  const [a, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(a, mes - 1, dia));
  return d.getUTCFullYear() === a && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

/**
 * A data prometida ao cliente (`sales_orders.ready_by_date`, `YYYY-MM-DD`) no formato do Omie, ou null.
 * `hoje` = hojeSP(). Null — e o campo NÃO vai — quando ausente, ilegível ou já no passado: o front recusa
 * prometer ontem, então data vencida aqui é pedido antigo reeditado, e mandá-la seria afirmar um prazo
 * que já não vale.
 */
export function previsaoEntregaOmie(readyByDate: unknown, hoje: string): string | null {
  if (!diaIsoValido(readyByDate) || !diaIsoValido(hoje)) return null;
  if (readyByDate < hoje) return null; // lexical em YYYY-MM-DD = cronológica
  return paraDataOmie(readyByDate);
}

/** `dDtPrevisao` da OP: a data prometida quando vale, senão hoje (o campo é obrigatório no Omie). */
export function previsaoOrdemProducao(readyByDate: unknown, hoje: string): string {
  return previsaoEntregaOmie(readyByDate, hoje) ?? paraDataOmie(hoje);
}
