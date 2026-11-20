// ── Trava de crédito — gate na fronteira comum (TODAS as vias de pedido passam por aqui).
// Specs: docs/superpowers/specs/trava-credito-fase2.md (v1) +
//        docs/superpowers/specs/2026-11-20-credito-ia-design.md §9.3/§9.4 (PR 1, 2026-11-20).
// Prova PG17 da RPC: db/test-trava-credito-piso-grupo.sh. Regras:
//  - piso = vencido > 60 d em QUALQUER par do grupo do DONO do par comprovado (canônico + aliases
//    active), sem exceção deste pedido para o par. Nunca o UUID do pedido (pode ser o do vendedor);
//  - FAIL-CLOSED: gate que não responde SEGURA o envio (`credito_indisponivel`) — antes liberava
//    com log (P1 Codex 2026-11-20). O log de indisponibilidade é best-effort: o desfecho já é segurar;
//  - bloqueio exige log DURÁVEL (a aprovação remota do gestor lê o último log do pedido).

import { mensagemDeErro } from "../_shared/erro-mensagem.ts";

/** O subconjunto do SupabaseClient que este módulo usa — facilita o duplo de teste. */
export interface ClienteGate {
  rpc(
    nome: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(tabela: string): {
    insert(linha: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
  };
}

export interface ParVencido {
  company: string;
  codigo: number;
  vencido: number;
  titulos: number;
  vencimento_mais_antigo: string | null;
}

export interface GateCreditoResultado {
  bloqueado: boolean;
  vencido: number | null;
  titulos: number;
  vencimento_mais_antigo: string | null;
  excecao_id: string | null;
  pares: ParVencido[];
  grupo_resolvido: boolean;
  motivo: string;
}

export type DesfechoGate =
  | { permitido: true; gate: GateCreditoResultado }
  | { permitido: false; motivo: "credito"; gate: GateCreditoResultado }
  | { permitido: false; motivo: "credito_indisponivel"; detalhe: string };

export const MENSAGEM_CREDITO_INDISPONIVEL =
  "Verificação de crédito indisponível — tente de novo em instantes.";

export async function gateCredito(
  supabase: ClienteGate,
  args: {
    company: "oben" | "colacor";
    /** Código Omie COMPROVADO do cliente nesta conta — o grupo é expandido a partir dele. */
    codigo: number | null;
    salesOrderId: string;
    userId: string | null;
    contexto: "criacao" | "edicao";
  },
): Promise<DesfechoGate> {
  const { company, codigo, salesOrderId, userId, contexto } = args;
  let gate: GateCreditoResultado;
  try {
    const { data, error } = await supabase.rpc("venda_gate_credito_grupo", {
      p_sales_order_id: salesOrderId,
      p_company: company,
      p_codigo: codigo,
    });
    if (error) throw new Error(error.message);
    if (!data || typeof (data as { bloqueado?: unknown }).bloqueado !== "boolean") {
      throw new Error("resposta do gate sem 'bloqueado'");
    }
    gate = data as GateCreditoResultado;
  } catch (rpcErr) {
    const msg = mensagemDeErro(rpcErr) ?? "gate de crédito sem resposta";
    const { error: logErr } = await supabase.from("venda_bloqueio_credito_log").insert({
      company,
      omie_codigo_cliente: codigo,
      sales_order_id: salesOrderId,
      acao: "gate_indisponivel",
      user_id: userId,
      detalhe: `${contexto}: ${msg}`.slice(0, 500),
    });
    if (logErr) console.warn(`[gate-credito] log gate_indisponivel falhou: ${logErr.message}`);
    console.warn(`[gate-credito][${company}] indisponível (${contexto}): ${msg} — SEGURADO`);
    return { permitido: false, motivo: "credito_indisponivel", detalhe: msg.slice(0, 300) };
  }

  if (!gate.bloqueado) {
    if (gate.excecao_id) {
      // Liberação por exceção é auditada (best-effort: falha de auditoria de sucesso não trava venda).
      const { error: logErr } = await supabase.from("venda_bloqueio_credito_log").insert({
        company,
        omie_codigo_cliente: codigo,
        sales_order_id: salesOrderId,
        acao: "liberado_excecao",
        vencido: gate.vencido,
        titulos: gate.titulos,
        user_id: userId,
        excecao_id: gate.excecao_id,
      });
      if (logErr) console.warn(`[gate-credito] log liberado_excecao falhou: ${logErr.message}`);
    }
    return { permitido: true, gate };
  }

  const { error: logErr } = await supabase.from("venda_bloqueio_credito_log").insert({
    company,
    omie_codigo_cliente: codigo,
    sales_order_id: salesOrderId,
    acao: contexto === "edicao" ? "bloqueado_edicao" : "bloqueado",
    vencido: gate.vencido,
    titulos: gate.titulos,
    user_id: userId,
    detalhe: gate.pares.length > 0
      ? `pares: ${gate.pares.map((p) => `${p.company}/${p.codigo}=${p.vencido}`).join(", ")}`.slice(0, 500)
      : null,
  });
  if (logErr) {
    // Bloqueio sem rastro deixaria o gestor SEM form de exceção → erro (o caller reexecuta).
    throw new Error(`Bloqueio de crédito sem log durável (${logErr.message}) — tente novamente.`);
  }
  return { permitido: false, motivo: "credito", gate };
}

/** Parcela "sem prazo informado" — o edge envia "999" quando o pedido não traz parcela. */
function normalizarParcela(p: string | null | undefined): string {
  const t = (p ?? "").trim();
  return t === "" ? "999" : t;
}

/**
 * Edição precisa passar pelo gate? Sim se o subtotal SOBE (mais exposição) ou se a
 * parcela MUDA (prazo pode ter subido com o mesmo total — P1 Codex 2026-11-20). No PR 1
 * qualquer troca de parcela basta: o gate só cobra o piso, inofensivo para quem está em dia.
 * "Só se o prazo sobe" chega no PR 3 com credito_prazo_dias.
 */
export function edicaoExigeGate(args: {
  subtotalNovo: number;
  subtotalOmie: number;
  parcelaNova: string | null | undefined;
  parcelaOmie: string | null | undefined;
}): boolean {
  if (args.subtotalNovo > args.subtotalOmie) return true;
  return normalizarParcela(args.parcelaNova) !== normalizarParcela(args.parcelaOmie);
}
