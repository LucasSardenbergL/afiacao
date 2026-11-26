// ── Gate de crédito v2 EFETIVO — crédito-IA 6b (DORMENTE: só morde com o flag ligado).
// RPC: public.credito_gate_v2_efetivo (migration 20261125230000). Desenho + parecer Codex:
// side-session-notes "pr6b-desenho.md" / docs/historico/credito-fila-enforcement-dormente-2026-11.md.
//
// Contrato com a edge (decisões pós-Codex 2026-11-26):
//  - `desligado` (flag da conta REAL do pedido desligado) → SEGUE, sem log nem efeito: com o flag
//    desligado o envio é o caminho de hoje, mais esta única chamada. Quem decide pular é a RPC,
//    nunca um leitor do flag aqui (comentário da migration).
//  - `avaliado` + faixa `verde` → SEGUE.
//  - TODO o resto SEGURA, como ERRO (nunca `blocked` novo: bundle antigo lê `blocked`
//    desconhecido como sucesso — index.ts, mesmo motivo do `credito_indisponivel`):
//      · amarelo → aguardando autorização na fila /credito/fila;
//      · vermelho → recusado pela regra v2;
//      · pedido_inexistente / conta_divergente / revisao_inexistente / revisao_superada → seguro
//        e revalido (nunca despacho conteúdo velho; `pedido_inexistente` vem ANTES do flag na RPC);
//      · erro de transporte, 22023 ou resposta sem forma → indisponível. Sem veredito a edge não
//        sabe o flag; uma resposta perdida pode esconder uma avaliação já gravada (Codex Q1, P0).
//        É o ÚNICO desvio do caminho de hoje com o flag desligado: a RPC fora do ar segura o envio.

import { mensagemDeErro } from "../_shared/erro-mensagem.ts";

/** Subconjunto do SupabaseClient usado aqui (duplo de teste). */
export interface ClienteGateV2 {
  rpc(
    nome: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export type DesfechoGateV2 =
  | { segue: true; resultado: "desligado" | "verde" }
  | { segue: false; resultado: string; mensagem: string };

export const MENSAGEM_V2_INDISPONIVEL =
  "Pedido não enviado: a verificação de crédito (v2) não respondeu. Tente de novo em instantes.";
export const MENSAGEM_V2_AMARELO =
  "Pedido não enviado: aguardando autorização de crédito na fila (/credito/fila). Reenvie depois da autorização.";
export const MENSAGEM_V2_VERMELHO =
  "Pedido não enviado: crédito recusado pela regra do limite do grupo.";
export const MENSAGEM_V2_REVALIDAR =
  "Pedido não enviado: a revisão de crédito deste pedido mudou. Recarregue o pedido e envie de novo.";

const REVALIDAR = new Set(["pedido_inexistente", "conta_divergente", "revisao_inexistente", "revisao_superada"]);

export async function gateV2Efetivo(
  cliente: ClienteGateV2,
  args: {
    salesOrderId: string;
    company: string;
    /** id da revisão registrada (PR 3); null quando o registro falhou — a RPC decide. */
    revisao: string | null;
    contexto: "criacao" | "edicao";
  },
): Promise<DesfechoGateV2> {
  const { salesOrderId, company, revisao, contexto } = args;
  let data: unknown;
  try {
    const r = await cliente.rpc("credito_gate_v2_efetivo", {
      p_sales_order_id: salesOrderId,
      p_company: company,
      p_revisao: revisao,
    });
    if (r.error) throw new Error(r.error.message);
    data = r.data;
  } catch (e) {
    const msg = (mensagemDeErro(e) ?? "sem resposta").slice(0, 300);
    console.warn(`[gate-v2][${company}] indisponível (${contexto}): ${msg} — SEGURADO`);
    return { segue: false, resultado: "indisponivel", mensagem: `${MENSAGEM_V2_INDISPONIVEL} (${msg})` };
  }

  const o = (data && typeof data === "object" && !Array.isArray(data)) ? data as Record<string, unknown> : null;
  const resultado = typeof o?.resultado === "string" ? o.resultado : null;

  if (resultado === "desligado" && o?.ligado === false) return { segue: true, resultado: "desligado" };

  if (resultado === "avaliado") {
    const faixa = o?.faixa;
    if (faixa === "verde") return { segue: true, resultado: "verde" };
    if (faixa === "amarelo") {
      const sol = typeof o?.solicitacao_id === "string" ? ` · solicitação ${o.solicitacao_id}` : "";
      console.warn(`[gate-v2][${company}] amarelo (${contexto}) — SEGURADO na fila${sol}`);
      return { segue: false, resultado: "amarelo", mensagem: `${MENSAGEM_V2_AMARELO}${sol}` };
    }
    if (faixa === "vermelho") {
      console.warn(`[gate-v2][${company}] vermelho (${contexto}) — RECUSADO (${String(o?.motivo ?? "?")})`);
      return { segue: false, resultado: "vermelho", mensagem: MENSAGEM_V2_VERMELHO };
    }
  }

  if (resultado !== null && REVALIDAR.has(resultado)) {
    console.warn(`[gate-v2][${company}] ${resultado} (${contexto}) — SEGURADO para revalidar`);
    return { segue: false, resultado, mensagem: `${MENSAGEM_V2_REVALIDAR} (${resultado})` };
  }

  // Forma desconhecida (inclui `desligado` sem ligado:false e `avaliado` sem faixa): sem veredito.
  console.warn(`[gate-v2][${company}] resposta sem forma (${contexto}): ${JSON.stringify(data).slice(0, 200)} — SEGURADO`);
  return { segue: false, resultado: "indisponivel", mensagem: `${MENSAGEM_V2_INDISPONIVEL} (resposta sem forma)` };
}
