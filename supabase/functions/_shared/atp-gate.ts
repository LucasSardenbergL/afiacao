// ATP fase 2 — classificação PURA do retorno/erro da RPC atp_gate_pedido.
// A decisão de bloquear/seguir do edge omie-vendas-sync passa por aqui;
// lógica extraída para teste Deno (test:edges roda _test.ts com --no-remote).
//
// Contrato da RPC (migration 20260807015000_atp_gate_pedido_fase2): jsonb
//   {ok:true, resultado:'reservado'|'ja_enviado'|'fora_do_pool'|'backorder_autorizado'|'advisory_bloqueado', ...}
//   {ok:false, blocked:'atp', resultado:'bloqueado', recusas:[...]}
// Erros SQL: 42501 (autorização/override inválido) e 22023 (contrato/dado) são
// classe SEM override — bug ou request forjado nunca viram backorder; falha de
// transporte (timeout/5xx, sem SQLSTATE conhecida) é contingência COM fricção.

export interface AtpGateClassificacao {
  acao: "seguir" | "bloquear" | "falha_verificacao";
  /** resultado da RPC quando ok (reservado, ja_enviado, backorder_autorizado, advisory_bloqueado…) */
  resultado: string | null;
  /** recusas estruturadas (bloqueio, ou advisory que teria bloqueado) */
  recusas: unknown[] | null;
  /** true quando advisory registrou que TERIA bloqueado (caller sem capability) */
  bloquearia: boolean;
  /** true quando o erro é classe sem-override (42501/22023) */
  semOverride: boolean;
  /** mensagem curta p/ log/resposta (nunca vira sucesso silencioso) */
  detalhe: string | null;
}

function base(): AtpGateClassificacao {
  return {
    acao: "falha_verificacao",
    resultado: null,
    recusas: null,
    bloquearia: false,
    semOverride: false,
    detalhe: null,
  };
}

/** Classifica o RETORNO (data) da RPC. Shape fora do contrato → falha_verificacao (fail-closed). */
export function classificarRetornoAtpGate(data: unknown): AtpGateClassificacao {
  const r = base();
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    r.detalhe = "retorno da RPC fora do contrato";
    return r;
  }
  const d = data as Record<string, unknown>;
  if (d.ok === true) {
    r.acao = "seguir";
    r.resultado = typeof d.resultado === "string" ? d.resultado : null;
    r.bloquearia = d.bloquearia === true;
    r.recusas = Array.isArray(d.recusas) ? d.recusas : null;
    return r;
  }
  if (d.ok === false && d.blocked === "atp") {
    const recusas = Array.isArray(d.recusas) ? d.recusas : null;
    if (!recusas || recusas.length === 0) {
      // bloqueio sem recusas nomeadas é contrato quebrado — não fabricar recusa
      r.detalhe = "bloqueio ATP sem recusas no retorno";
      return r;
    }
    r.acao = "bloquear";
    r.resultado = "bloqueado";
    r.recusas = recusas;
    return r;
  }
  r.detalhe = "retorno da RPC fora do contrato";
  return r;
}

/** Classifica o ERRO da RPC (PostgREST error plano {code,message} ou exceção crua). */
export function classificarErroAtpGate(err: unknown): AtpGateClassificacao {
  const r = base();
  const obj = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : null;
  const code = obj && typeof obj.code === "string" ? obj.code : null;
  const message = obj && typeof obj.message === "string" ? obj.message : null;
  r.detalhe = message ?? "falha ao verificar disponibilidade de estoque";
  if (code === "42501" || code === "22023") {
    r.semOverride = true;
  }
  return r;
}
