// ── Revisão imutável da operação (crédito-IA PR 3) — o que é avaliado é o que é enviado.
// Migration: supabase/migrations/20261121180000_credito_prazo_revisao.sql (prova PG17:
// db/test-credito-prazo-revisao.sh). Plano: docs/superpowers/plans/2026-11-20-credito-ia.md "PR 3".
// Regras:
//  - a revisão é registrada ANTES do gate, com a parcela EFETIVA e a projeção money-path dos itens;
//    o envio ao Omie usa código/quantidade/preço DA REVISÃO devolvida (correspondência item a item);
//  - NÃO é fail-closed no PR 3 (Codex P1 / spec §10: a trava nova só liga após a 1ª leva): falha
//    vira `null` + log, e o pedido segue o caminho do PR 1 (o piso continua fail-closed);
//  - parcela ausente não some: vira `999` marcada `default_999` (prazo NULL → 🟡 no PR 5).

import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import type { ClienteGate } from "./gate-credito.ts";

export type OrigemParcela = "informada" | "herdada_omie" | "default_999";

export interface ItemRevisao {
  codigo_produto: number;
  quantidade: number;
  valor_unitario: number;
}

export interface RevisaoCredito {
  revisao: string;
  seq: number;
  reusada: boolean;
  codigo_parcela: string;
  parcela_origem: OrigemParcela;
  prazo_dias: number | null;
  prazo_fonte: "override" | "catalogo" | null;
  itens: ItemRevisao[];
  valor_brl: number;
}

interface ItemPayload {
  omie_codigo_produto?: number | string;
  quantidade?: number;
  valor_unitario?: number;
}

/** Parcela efetiva: a informada; senão a atual do PV (edição); senão `999` (o default de sempre). */
export function parcelaEfetiva(
  informada: string | null | undefined,
  atualOmie?: string | null,
): { codigo: string; origem: OrigemParcela } {
  const i = typeof informada === "string" ? informada.trim() : "";
  if (i !== "") return { codigo: i, origem: "informada" };
  const a = typeof atualOmie === "string" ? atualOmie.trim() : "";
  if (a !== "") return { codigo: a, origem: "herdada_omie" };
  return { codigo: "999", origem: "default_999" };
}

/** Projeção money-path do que vai ao Omie, na ordem do envio. */
export function projetarItens(items: ItemPayload[]): Array<Record<string, unknown>> {
  return items.map((it) => ({
    codigo_produto: it.omie_codigo_produto,
    quantidade: it.quantidade,
    valor_unitario: it.valor_unitario,
  }));
}

/** Registra (ou reusa) a revisão. Falha → `null` (não segura o envio no PR 3). */
export async function registrarRevisao(
  supabase: ClienteGate,
  args: {
    salesOrderId: string;
    company: string;
    contexto: "criacao" | "edicao";
    codigoCliente: number | null;
    parcela: { codigo: string; origem: OrigemParcela };
    items: ItemPayload[];
    userId: string | null;
  },
): Promise<RevisaoCredito | null> {
  try {
    const { data, error } = await supabase.rpc("credito_registrar_revisao", {
      p_sales_order_id: args.salesOrderId,
      p_company: args.company,
      p_contexto: args.contexto,
      p_omie_codigo_cliente: args.codigoCliente,
      p_codigo_parcela: args.parcela.codigo,
      p_parcela_origem: args.parcela.origem,
      p_itens: projetarItens(args.items),
      p_user_id: args.userId,
    });
    if (error) throw new Error(error.message);
    const rev = data as RevisaoCredito | null;
    if (!rev || typeof rev.revisao !== "string" || !Array.isArray(rev.itens)) {
      throw new Error("resposta sem 'revisao'/'itens'");
    }
    return rev;
  } catch (e) {
    console.warn(
      `[revisao-credito][${args.company}] revisão NÃO registrada (${args.contexto}, pedido ${args.salesOrderId}): ` +
        `${mensagemDeErro(e) ?? "erro"} — segue o caminho do PR 1`,
    );
    return null;
  }
}

/**
 * Itens para o envio: os campos cosméticos (tint, descrição) vêm do payload; código, quantidade e
 * preço vêm DA REVISÃO. Divergência de tamanho ou de código item a item lança — não se envia algo
 * diferente do que foi registrado.
 */
export function itensDaRevisao<T extends ItemPayload>(items: T[], rev: RevisaoCredito | null): T[] {
  if (!rev) return items;
  if (rev.itens.length !== items.length) {
    throw new Error(`Revisão ${rev.revisao} tem ${rev.itens.length} itens e o envio ${items.length} — envio recusado`);
  }
  return items.map((it, i) => {
    const r = rev.itens[i];
    if (Number(it.omie_codigo_produto) !== Number(r.codigo_produto)) {
      throw new Error(
        `Revisão ${rev.revisao}: item ${i} é ${r.codigo_produto} e o envio ${it.omie_codigo_produto} — envio recusado`,
      );
    }
    return { ...it, omie_codigo_produto: r.codigo_produto, quantidade: r.quantidade, valor_unitario: r.valor_unitario };
  });
}

/** Calendário da parcela SÓ quando provado pelo catálogo (override escalar não prova calendário). */
export async function calendarioDaParcela(
  supabase: ClienteGate,
  codigo: string,
  company: string,
): Promise<number[] | null> {
  try {
    const { data, error } = await supabase.rpc("credito_prazo_resolver", {
      p_codigo_parcela: codigo,
      p_account: company,
    });
    if (error) throw new Error(error.message);
    const r = data as { fonte?: unknown; calendario?: unknown } | null;
    if (r?.fonte !== "catalogo" || !Array.isArray(r.calendario)) return null;
    const cal = r.calendario.map(Number);
    return cal.length > 0 && cal.every((d) => Number.isInteger(d) && d >= 0) ? cal : null;
  } catch (e) {
    console.warn(`[revisao-credito][${company}] prazo da parcela ${codigo} indisponível: ${mensagemDeErro(e) ?? "erro"}`);
    return null;
  }
}

/**
 * `novo` domina-ou-iguala `antigo` quando, em TODO vencimento t, a fração do valor já recebida sob
 * `novo` é ≥ a sob `antigo` (parcelas iguais). Só então trocar de condição não aumenta o risco
 * (Codex P1: 30/60/90 → 75 dias encurta o máximo mas ATRASA o recebimento — não domina).
 */
export function dominaOuIguala(novo: number[], antigo: number[]): boolean {
  if (novo.length === 0 || antigo.length === 0) return false;
  const frac = (cal: number[], t: number) => cal.filter((d) => d <= t).length / cal.length;
  for (const t of new Set([...novo, ...antigo])) {
    if (frac(novo, t) < frac(antigo, t)) return false;
  }
  return true;
}
