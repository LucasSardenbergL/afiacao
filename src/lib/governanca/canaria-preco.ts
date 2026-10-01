// Canária comportamental do edge de preço — classificação do resultado.
//
// Contexto: o edge `analyze-unified-order` aceita `{canary:true}` (criado no #1089) e roda a MESMA
// fronteira de saída do fluxo real (`montarRespostaAnalise`, via `canariaSemPreco` em saida-ia.ts)
// sobre uma fixture cujos itens TRAZEM preço, devolvendo {canary,contrato,precos_na_saida,itens_na_saida,ok}.
// Como o deploy do Lovable pode REVERTER a edge silenciosamente (o repo fica certo, mas a edge servida
// não), o widget de Governança chama essa canária e classifica a resposta aqui. É a Opção A da
// mitigação de reversão do Lovable (detecta edge revertida em PROD). Ver docs/agent/deploy.md.
//
// O QUE ELA ATESTA desde 2026-09-30: a IA NÃO precifica — nenhum preço sai da edge; o preço de
// nascimento do item tem um decisor só, o `precoPartida` do front. Até então atestava o merge
// "praticado vence Omie" (`praticado-vence-omie-v1`), que saiu da edge junto com o enriquecimento.
//
// REGRA money-path (Codex): erro HTTP (401/403/4xx/5xx) é FALHA de canária, NÃO "sem dados" —
// senão uma edge quebrada/derrubada apareceria como neutra em vez de vermelha.

export type StatusCanaria = "ok" | "falha" | "erro" | "desconhecido";

export interface RespostaCanaria {
  canary?: boolean;
  contrato?: string;
  precos_na_saida?: number;
  itens_na_saida?: number;
  ok?: boolean;
}

export interface ResultadoCanaria {
  status: StatusCanaria;
  detalhe: string;
}

// VERSION MARKER da fatia (docs/agent/deploy.md §Canárias, ⚠️ #2). Exigir o VALOR é o que separa
// "a edge respondeu" de "a edge é a versão que eu deployei": um deploy INTEGRALMENTE VELHO responde a
// canária VELHA, e sem esta constante o card não teria como desempatar. Bump aqui E na edge
// (`CONTRATO_CANARIA_PRECO` em supabase/functions/analyze-unified-order/saida-ia.ts), juntos.
const CONTRATO_ESPERADO = "ia-nao-precifica-v1";
// O contrato da fatia ANTERIOR: no ar, significa que a edge servida ainda PRECIFICA (deploy pendente
// ou revertido pelo Lovable). Nome próprio porque é o estado mais provável entre o Publish e o deploy.
const CONTRATO_ANTERIOR = "praticado-vence-omie-v1";
// A fixture da canária tem 1 produto + 1 sugestão: os dois têm de SAIR (zero preços porque zero itens
// é o sempre-verde, não a propriedade).
const ITENS_ESPERADOS = 2;

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
  // Marcador ausente = a canária no ar é PRÉ-marcador, ou seja bundle anterior a esta fatia. Não é
  // "sem dados": a edge respondeu, e o que ela respondeu prova que está velha.
  if (data.contrato === undefined || data.contrato === null) {
    return {
      status: "falha",
      detalhe: `Canária respondeu sem o marcador de contrato (esperado \`${CONTRATO_ESPERADO}\`). O bundle no ar é ANTERIOR ao versionamento da canária — deploy pendente.`,
    };
  }
  if (data.contrato === CONTRATO_ANTERIOR) {
    return {
      status: "falha",
      detalhe: `A edge no ar ainda PRECIFICA: respondeu a canária da fatia anterior (\`${CONTRATO_ANTERIOR}\`), esperado \`${CONTRATO_ESPERADO}\`. Deploy da analyze-unified-order pendente (ou revertido pelo Lovable) — o item da IA pode nascer com o preço da edge em vez do precoPartida.`,
    };
  }
  // Marcador de OUTRA fatia = deploy que não é o desta. É a mentira verde que o marcador existe para
  // pegar: `ok` pode estar "certo" e ainda assim ser o de outra fatia.
  if (data.contrato !== CONTRATO_ESPERADO) {
    return {
      status: "falha",
      detalhe: `Canária de OUTRA fatia no ar: contrato=\`${data.contrato}\`, esperado \`${CONTRATO_ESPERADO}\`. O \`ok\` desta resposta não prova o deploy desta fatia.`,
    };
  }
  // Verde SÓ com o contrato da fatia E os 3 campos batendo: nenhum preço saiu e os itens saíram.
  if (data.ok === true && data.precos_na_saida === 0 && data.itens_na_saida === ITENS_ESPERADOS) {
    return {
      status: "ok",
      detalhe: `A edge servida não precifica: nenhum preço atravessou a fronteira de saída e os ${ITENS_ESPERADOS} itens da fixture saíram.`,
    };
  }
  // Qualquer outra combinação = regressão (a edge voltou a emitir preço, ou a fronteira descarta itens).
  return {
    status: "falha",
    detalhe: `REGRESSÃO money-path: precos_na_saida=${fmtNum(data.precos_na_saida)}, itens_na_saida=${fmtNum(data.itens_na_saida)}, ok=${String(data.ok)} (esperado 0 preços, ${ITENS_ESPERADOS} itens, ok=true). A edge deployada voltou a emitir preço ou descarta itens — ver docs/agent/deploy.md (verificação pós-deploy).`,
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
