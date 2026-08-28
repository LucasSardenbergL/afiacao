// Lógica PURA do worker da `analytics_outbox`: montar o payload do PostHog e
// classificar a resposta HTTP.
//
// Vive separado do index.ts porque a suíte Deno roda com `--no-remote`: um teste
// que importasse a edge puxaria `npm:@supabase/supabase-js@2` e colocaria o
// registry no caminho de entrega de TODO PR. Nada aqui importa nada.

/** Uma linha reivindicada por `analytics_outbox_claim()`. */
export interface LinhaOutbox {
  id: number;
  event_id: string;
  evento: string;
  distinct_id: string;
  props: Record<string, unknown> | null;
  ocorrido_em: string;
  tentativas: number;
}

/** O formato que o `/batch/` do PostHog consome. */
export interface EventoPostHog {
  uuid: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

/** Marca a via, para a leitura conseguir separar este cano do browser. */
export const LIB_OUTBOX = "analytics-outbox";

/**
 * Monta o evento a partir da linha persistida.
 *
 * ⚠️ Os QUATRO campos de dedup do PostHog saem da LINHA, nunca do relógio do
 * worker. Verificado em posthog.com/docs/data/events (2026-08-25): "Events that
 * share the same uuid, event name, timestamp, and distinct_id are treated as
 * duplicates", e "Keep the timestamp identical to the original, or the event
 * won't be deduplicated". Recalcular `timestamp` no retry faria cada tentativa
 * virar um evento NOVO — o retry passaria a inflar a contagem que ele deveria
 * preservar, e a métrica que decide compra sairia inflada.
 *
 * `uuid` vai TOP-LEVEL, não como `$insert_id` em properties: `$insert_id` não é
 * a chave de dedup desta API.
 */
export function montarEvento(linha: LinhaOutbox): EventoPostHog {
  const props: Record<string, unknown> = { ...(linha.props ?? {}) };

  // Sem isto, a leitura mistura os canos — e um agregado que soma browser com
  // server-side lê como saudável um canal que, exercitado, não entrega (#1967).
  props.$lib = LIB_OUTBOX;

  // Fato do sistema não é pessoa: não criar perfil para 'sistema:reposicao'.
  // Por padrão o PostHog trata evento vindo da API como identificado.
  if (ehSintetico(linha.distinct_id)) {
    props.$process_person_profile = false;
  }

  return {
    uuid: linha.event_id,
    event: linha.evento,
    distinct_id: linha.distinct_id,
    timestamp: linha.ocorrido_em,
    properties: props,
  };
}

/** `sistema:<dominio>` é um id sintético, não um titular. */
export function ehSintetico(distinctId: string): boolean {
  return distinctId.startsWith("sistema:");
}

export type Desfecho = "aceito" | "transitorio" | "permanente";

/**
 * ⚠️ "aceito" quer dizer ACEITE HTTP, não ingestão provada: o PostHog documenta
 * que evento sem nome ou sem distinct_id válido pode ser descartado e ainda
 * responder 200. Quem confere ingestão de verdade é a view de reconciliação, na
 * origem — por isso a coluna se chama `aceito_em` e não `enviado_em`.
 *
 * 401/403 é configuração quebrada: insistir só queima quota e mantém dado
 * pessoal parado na fila. Vai para quarentena com alerta, não para o backoff.
 */
export function classificarResposta(status: number): Desfecho {
  if (status >= 200 && status < 300) return "aceito";
  if (status === 408 || status === 429) return "transitorio";
  if (status >= 500) return "transitorio";
  // 0 = falha de rede/timeout antes de haver status
  if (status === 0) return "transitorio";
  return "permanente";
}

/** Teto de segurança do lote. O `/batch/` aceita bem mais, mas um corpo grande
 *  vira 413 — que é permanente e mataria o lote inteiro por tamanho. */
export const TETO_EVENTOS_POR_LOTE = 200;
const TETO_BYTES_POR_LOTE = 1_000_000;

/**
 * Parte o lote em pedaços que cabem no teto de bytes. Sem isto, uma props
 * grande faz o lote inteiro cair no mesmo 413 — e cada retry repete o erro.
 */
export function particionar(
  eventos: EventoPostHog[],
  tetoBytes: number = TETO_BYTES_POR_LOTE,
): EventoPostHog[][] {
  const lotes: EventoPostHog[][] = [];
  let atual: EventoPostHog[] = [];
  let bytes = 0;
  for (const ev of eventos) {
    const tamanho = JSON.stringify(ev).length;
    // Um evento sozinho maior que o teto ainda vai — sozinho. Segurá-lo aqui só
    // o esconderia; mandando, o 413 marca ELE de quarentena em vez do lote.
    if (atual.length > 0 && bytes + tamanho > tetoBytes) {
      lotes.push(atual);
      atual = [];
      bytes = 0;
    }
    atual.push(ev);
    bytes += tamanho;
  }
  if (atual.length > 0) lotes.push(atual);
  return lotes;
}

/** Mensagem de erro curta e SEM payload — tirar PII da outbox e guardá-la no
 *  campo de erro não minimizaria nada. */
export function resumirErro(status: number, corpo: string): string {
  return `HTTP ${status}: ${corpo.slice(0, 200)}`;
}
