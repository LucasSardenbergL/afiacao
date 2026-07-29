// Contrato de ESCRITA CRÍTICA para edges money-path.
//
// Irmão do `fetchAll` (_shared/paginate.ts) no eixo da ESCRITA. Na LEITURA a falha
// virava lista vazia — "não consegui ler" indistinguível de "não existe". Na ESCRITA
// ela vira SILÊNCIO TOTAL: o supabase-js NÃO lança em erro de banco, resolve normal
// com `error` preenchido. Um `await supabase.from(x).insert(...)` que ignora o retorno
// devolve HTTP 200 sem ter gravado nada, e nenhuma camada acima consegue distinguir
// "gravou" de "não gravou" — por construção, igual ao furo de contrato do §6.
//
// Medido em prod 2026-07-28: o cron `fin-cashflow-snapshot-diario` (3 empresas × 3
// cenários = 9 execuções/dia) gravou 8 dos 9 snapshots — faltou oben/pessimista — e
// ninguém foi notificado. Quando fui investigar, a evidência HTTP (net._http_response,
// retenção de horas) já havia sido purgada: a falha não era mais nem diagnosticável.
//
// ⚠️ PII — o `error.message` do PostgREST encaminha o MESSAGE do Postgres, que PODE
// interpolar valor de linha (RAISE EXCEPTION citando id/CPF, erro de cast reproduzindo
// o valor inválido). O `Error` que sobe daqui alimenta o corpo da resposta HTTP 500 do
// serve(), então carrega só domínio FECHADO: alvo + SQLSTATE. A mensagem crua fica no
// console do Deno (acesso restrito ao dashboard). Não se afirma "sem PII" sobre texto
// produzido por terceiro sem verificar quem o produz e onde ele deságua (§ money-path).

/** Shape mínimo do erro do PostgREST — só o que este contrato lê. */
export interface ErroEscrita {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
}

/** Shape mínimo da resposta de escrita do supabase-js. */
export interface RespostaEscrita {
  error: ErroEscrita | null;
}

export class EscritaCriticaError extends Error {
  readonly alvo: string;
  readonly code: string | null;

  constructor(alvo: string, code: string | null) {
    super(`escrita crítica falhou: ${alvo}${code ? ` (SQLSTATE ${code})` : ""}`);
    this.name = "EscritaCriticaError";
    this.alvo = alvo;
    this.code = code;
  }
}

/**
 * Executa uma escrita e LANÇA se o banco recusou.
 *
 * `alvo` é o rótulo de domínio que aparece na resposta HTTP (ex.:
 * "fin_projecao_snapshots.insert") — mantenha-o descritivo e livre de dado de linha.
 *
 * Não engole nada e não tem modo "melhor esforço": quem chama pode capturar a
 * exceção se aquele sítio específico puder degradar, mas a degradação passa a ser
 * uma DECISÃO explícita no call-site, nunca o default silencioso.
 */
export async function escritaCritica(
  alvo: string,
  op: PromiseLike<RespostaEscrita>,
): Promise<void> {
  const { error } = await op;
  if (!error) return;

  // Metadado completo só no log do Deno — nunca no corpo da resposta.
  console.error(`[escrita-critica] ${alvo} FALHOU`, {
    code: error.code ?? null,
    message: error.message ?? null,
    details: error.details ?? null,
    hint: error.hint ?? null,
  });

  throw new EscritaCriticaError(alvo, error.code ?? null);
}
