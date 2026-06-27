// Canária comportamental do edge de preço — classificação do resultado.
//
// Contexto: o edge `analyze-unified-order` aceita `{canary:true}` (criado no #1089) e roda o
// helper REAL de merge de preço com local=123 vs Omie=999, retornando {canary,resolved,expected,ok}.
// Como o deploy do Lovable pode REVERTER a edge silenciosamente (o repo fica certo, mas a edge
// servida não), o widget de Governança chama essa canária e classifica a resposta aqui. É a Opção A
// da mitigação de reversão do Lovable (detecta edge revertida em PROD). Ver docs/agent/deploy.md.
//
// REGRA money-path (Codex): erro HTTP (401/403/4xx/5xx) é FALHA de canária, NÃO "sem dados" —
// senão uma edge quebrada/derrubada apareceria como neutra em vez de vermelha.

export type StatusCanaria = "ok" | "falha" | "erro" | "desconhecido";

export interface RespostaCanaria {
  canary?: boolean;
  resolved?: number;
  expected?: number;
  ok?: boolean;
}

export interface ResultadoCanaria {
  status: StatusCanaria;
  detalhe: string;
}

const PRECO_PRATICADO = 123; // local (order_items) — deve VENCER
const PRECO_OMIE = 999; // fallback — só preenche gap

export function classificarCanaria(
  data: RespostaCanaria | null | undefined,
  error: unknown,
): ResultadoCanaria {
  // Erro de invoke (rede, 401/403/4xx/5xx) = canária VERMELHA, não "sem dados".
  if (error) {
    return {
      status: "erro",
      detalhe: `Falha ao chamar a edge analyze-unified-order: ${msgErro(error)}. Trate como canária vermelha (edge fora do ar ou sem acesso).`,
    };
  }
  // Resposta sem o envelope de canária: a edge não reconheceu {canary:true} (deploy sem a canária?).
  if (!data || data.canary !== true) {
    return {
      status: "desconhecido",
      detalhe: "A edge não retornou o envelope de canária ({canary:true}). Confirme que o deploy inclui a canária do #1089.",
    };
  }
  // Verde SÓ com os 3 campos batendo: o praticado venceu o Omie.
  if (data.ok === true && data.resolved === PRECO_PRATICADO && data.expected === PRECO_PRATICADO) {
    return {
      status: "ok",
      detalhe: `Fallback correto: o preço praticado (${PRECO_PRATICADO}) venceu o Omie (${PRECO_OMIE}).`,
    };
  }
  // Qualquer outra combinação = regressão (Omie sobrescrevendo o praticado / canária adulterada).
  return {
    status: "falha",
    detalhe: `REGRESSÃO money-path: resolved=${fmtNum(data.resolved)}, expected=${fmtNum(data.expected)}, ok=${String(data.ok)} (esperado resolved=expected=${PRECO_PRATICADO}, ok=true). A edge deployada pode estar revertida — ver docs/agent/deploy.md.`,
  };
}

function msgErro(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "erro desconhecido");
  }
  return String(error ?? "erro desconhecido");
}

function fmtNum(n: number | undefined): string {
  return typeof n === "number" ? String(n) : "ausente";
}
