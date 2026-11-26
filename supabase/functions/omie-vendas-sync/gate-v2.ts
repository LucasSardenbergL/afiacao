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
//      · amarelo COM solicitação → aguardando autorização na fila /credito/fila;
//      · amarelo SEM solicitação (pendência de grupo/títulos) → pendência, falar com o financeiro;
//      · vermelho → recusado (mensagem genérica: o motivo pode ser piso, não limite);
//      · `avaliado` só conta com ligado:true; verde exige decisao_id e reserva_id;
//      · pedido_inexistente / conta_divergente / revisao_inexistente / revisao_superada → seguro
//        e revalido (nunca despacho conteúdo velho; `pedido_inexistente` vem ANTES do flag na RPC);
//      · erro de transporte, 22023 ou resposta sem forma → indisponível. Sem veredito a edge não
//        sabe o flag; uma resposta perdida pode esconder uma avaliação já gravada (Codex Q1, P0).
//        É o ÚNICO desvio do caminho de hoje com o flag desligado: a RPC fora do ar segura o envio.

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
  "Pedido não enviado: crédito recusado. Fale com o financeiro antes de reenviar.";
export const MENSAGEM_V2_PENDENCIA =
  "Pedido não enviado: o crédito do cliente tem uma pendência de cadastro (grupo ou títulos). Fale com o financeiro antes de reenviar.";
export const MENSAGEM_V2_REVALIDAR =
  "Pedido não enviado: a revisão de crédito deste pedido mudou. Recarregue o pedido e envie de novo.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** id gravado pelo núcleo: UUID de verdade, nunca string vazia/espaço (Codex r2). */
const ehId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

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
  } catch {
    // Texto bruto da RPC NUNCA vai ao cliente nem ao log (Codex diff P1): pode carregar dado de crédito.
    console.warn(`[gate-v2][${company}] indisponível (${contexto}) — SEGURADO`);
    return { segue: false, resultado: "indisponivel", mensagem: MENSAGEM_V2_INDISPONIVEL };
  }

  const o = (data && typeof data === "object" && !Array.isArray(data)) ? data as Record<string, unknown> : null;
  const resultado = typeof o?.resultado === "string" ? o.resultado : null;

  if (resultado === "desligado" && o?.ligado === false) return { segue: true, resultado: "desligado" };

  // Avaliado só vale com ligado:true (o núcleo só roda com o flag ligado). Contraditório → sem forma.
  if (resultado === "avaliado" && o?.ligado === true) {
    const faixa = o.faixa;
    // Verde só segue com a decisão E a reserva gravadas pelo núcleo (Codex diff P1): verde sem os
    // ids não prova reserva nenhuma → sem forma, segura.
    if (faixa === "verde" && ehId(o.decisao_id) && ehId(o.reserva_id)) return { segue: true, resultado: "verde" };
    if (faixa === "amarelo") {
      if (ehId(o.solicitacao_id)) {
        console.warn(`[gate-v2][${company}] amarelo (${contexto}) — SEGURADO na fila · solicitação ${o.solicitacao_id}`);
        return { segue: false, resultado: "amarelo", mensagem: `${MENSAGEM_V2_AMARELO} · solicitação ${o.solicitacao_id}` };
      }
      // Amarelo SEM solicitação (sem_grupo, grupo_conflito, piso_indeterminado, grupo_mudou): ninguém
      // pode autorizar na fila — mandar aguardar seria prometer o que não existe (Codex diff P1).
      console.warn(`[gate-v2][${company}] amarelo sem solicitação (${contexto}) — SEGURADO por pendência`);
      return { segue: false, resultado: "pendencia", mensagem: MENSAGEM_V2_PENDENCIA };
    }
    if (faixa === "vermelho") {
      console.warn(`[gate-v2][${company}] vermelho (${contexto}) — RECUSADO`);
      return { segue: false, resultado: "vermelho", mensagem: MENSAGEM_V2_VERMELHO };
    }
  }

  if (resultado !== null && REVALIDAR.has(resultado)) {
    console.warn(`[gate-v2][${company}] ${resultado} (${contexto}) — SEGURADO para revalidar`);
    return { segue: false, resultado, mensagem: `${MENSAGEM_V2_REVALIDAR} (${resultado})` };
  }

  // Forma desconhecida (inclui `desligado` sem ligado:false, `avaliado` contraditório ou incompleto):
  // sem veredito. No log nada que venha do corpo (nem valores nem nomes de campo — Codex r2): só o
  // `resultado` quando é um dos conhecidos, e o tipo do corpo.
  const conhecidos = new Set(["desligado", "avaliado", ...REVALIDAR]);
  const rotulo = resultado !== null && conhecidos.has(resultado) ? resultado : "?";
  const tipo = o ? "objeto" : (Array.isArray(data) ? "array" : typeof data);
  console.warn(`[gate-v2][${company}] resposta sem forma (${contexto}): resultado=${rotulo} corpo=${tipo} — SEGURADO`);
  return { segue: false, resultado: "indisponivel", mensagem: MENSAGEM_V2_INDISPONIVEL };
}
