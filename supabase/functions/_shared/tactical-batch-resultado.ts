// Classificação e agregação do resultado por alvo do tactical-plans-batch.
//
// Lógica PURA extraída para caber no `--no-remote` do `test:edges` — o index.ts da edge
// importa `npm:@supabase/supabase-js` e não entra no grafo de teste (mesmo padrão de
// tactical-margem.ts). Testes em tactical-batch-resultado_test.ts.
//
// POR QUE EXISTE — incidente 2026-07-21, 1ª execução do cron (jobid 165):
//   {"ok":true,"farmers":3,"alvos":58,"gerados":30,"pulados":0,"erros":28}
// 48% dos alvos falharam, uma vendedora inteira ficou sem plano, e a edge respondeu
// `ok: true` com HTTP 200 — o cron marcaria `succeeded`. O laço fazia `else erros++`
// sem ler `r.status` nem `j.error`, então o MOTIVO se perdia: foi preciso re-executar
// o batch 3h depois só para descobrir que era transiente (429), não quota (402).
//
// Duas invariantes:
//   1. `ok` é falso quando há erro — resultado parcial não pode ler como sucesso.
//   2. Todo erro carrega o STATUS HTTP no motivo — é o que separa 429 de 402 de 500,
//      que exigem correções OPOSTAS (backoff não resolve crédito esgotado).
//
// REGISTRO SERVER-SIDE — incidente 2026-10-09: o cron marcou `succeeded` e criou ZERO planos
// (inclusive para vendedoras com 52 e 93 candidatos), e a causa ficou IRRECUPERÁVEL: o corpo
// da resposta só existia em net._http_response (TTL ~6h) e cron.job_run_details registra só o
// enqueue. `corpoDoLote` é a ÚNICA fonte do corpo — a resposta HTTP e o registro em
// acoes_execucoes (`detalhesDoRegistro`) saem dele, então não podem divergir.

import { inicioDiaOperacional } from "./dia-operacional.ts";

export type Classificacao =
  | { tipo: "gerado" }
  | { tipo: "pulado"; motivo: string }
  | { tipo: "erro"; motivo: string };

export interface ResumoLote {
  ok: boolean;
  gerados: number;
  pulados: number;
  erros: number;
  erros_por_motivo: Record<string, number>;
  pulados_por_motivo: Record<string, number>;
}

/**
 * Classifica a resposta de UM alvo (chamada a generate-tactical-plan).
 *
 * `skipped` é caminho ESPERADO, não falha: `ja_na_fila` (idempotência),
 * `sem_score` e `rpc_error` (race de reatribuição — a edge alvo já o trata).
 * Tratá-lo como erro apagaria o sinal que distingue "pulei de propósito" de
 * "quebrei" — foi `pulados: 0` que provou, no incidente, que os 28 erros não
 * vinham da RPC.
 *
 * O motivo do erro é `http_<status>`: chave ESTÁVEL, para agrupar. Mensagem livre
 * do gateway fragmentaria a contagem e não agrega ao diagnóstico — o status já
 * separa as classes que pedem conserto diferente.
 */
export function classificarAlvo(
  status: number,
  corpo: Record<string, unknown>,
): Classificacao {
  if (corpo.generated) return { tipo: "gerado" };
  if (corpo.skipped) return { tipo: "pulado", motivo: String(corpo.skipped) };
  // Inclui o caso traiçoeiro do HTTP 200 com corpo inesperado: contar como sucesso
  // fabricaria um plano que não existe (money-path — ausente ≠ zero).
  return { tipo: "erro", motivo: `http_${status}` };
}

/** Agrega as classificações do lote. `ok` reflete a VERDADE do lote, não o fato de ter rodado. */
export function agregar(classificacoes: Classificacao[]): ResumoLote {
  let gerados = 0;
  let pulados = 0;
  let erros = 0;
  const erros_por_motivo: Record<string, number> = {};
  const pulados_por_motivo: Record<string, number> = {};

  for (const c of classificacoes) {
    if (c.tipo === "gerado") {
      gerados++;
    } else if (c.tipo === "pulado") {
      pulados++;
      pulados_por_motivo[c.motivo] = (pulados_por_motivo[c.motivo] ?? 0) + 1;
    } else {
      erros++;
      erros_por_motivo[c.motivo] = (erros_por_motivo[c.motivo] ?? 0) + 1;
    }
  }

  return { ok: erros === 0, gerados, pulados, erros, erros_por_motivo, pulados_por_motivo };
}

/** Campos de CONTEXTO da execução (fora da agregação por alvo) — ver comentários no index.ts. */
export interface ContextoLote {
  farmers: number;
  alvos: number;
  mascarados_ignorados: number;
  sem_margem_indecidivel: number;
  ja_na_fila: number;
}

export type CorpoLote = ResumoLote & ContextoLote;

/** O corpo da resposta HTTP do batch. Fonte ÚNICA — o registro deriva dele. */
export function corpoDoLote(resumo: ResumoLote, contexto: ContextoLote): CorpoLote {
  return { ...resumo, ...contexto };
}

/**
 * `detalhes` do registro em acoes_execucoes: o corpo INTEIRO + quando foi gravado + o dia
 * operacional BRT (a régua da idempotência e da rotação; o dia UTC erra entre 21h e 24h BRT).
 * `agora` é parâmetro para ser testável sem relógio.
 */
export function detalhesDoRegistro(corpo: CorpoLote, agora: Date): Record<string, unknown> {
  return {
    ...corpo,
    registrado_em: agora.toISOString(),
    dia_operacional_brt: inicioDiaOperacional(agora).slice(0, 10),
  };
}
