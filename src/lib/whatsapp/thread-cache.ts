import type { WaMessage } from '@/queries/useWhatsappInbox';

/** Tamanho da janela da thread (fetch inicial e cada página de histórico). */
export const THREAD_LIMIT = 100;

/** Prefixo das mensagens otimistas injetadas pelo useSendWhatsapp (onMutate). */
export const OPTIMISTIC_MSG_PREFIX = 'optimistic-';

export function isOptimisticMessage(m: WaMessage): boolean {
  return m.id.startsWith(OPTIMISTIC_MSG_PREFIX);
}

/** Monta a mensagem otimista do envio (aparece na thread na hora do clique). */
export function montarMensagemOtimista(
  conversationId: string,
  body: string,
  nowIso: string,
): WaMessage {
  return {
    id: `${OPTIMISTIC_MSG_PREFIX}${nowIso}-${Math.floor(Math.random() * 1e6)}`,
    conversation_id: conversationId,
    direction: 'out',
    type: 'text',
    body,
    status: 'enviando',
    created_at: nowIso,
    wa_timestamp: null,
  };
}

/**
 * Append incremental de uma mensagem vinda do realtime no cache da thread
 * (substitui o invalidate que re-baixava a conversa INTEIRA a cada mensagem).
 *
 * Regras (todas testadas):
 *  - cache ausente → não cria (o fetch da thread popula quando a tela abrir);
 *  - dedupe por id (replay/duplicata do realtime não duplica balão);
 *  - mensagem OUT substitui a 1ª otimista de mesmo body (o INSERT real da
 *    mensagem que o próprio usuário enviou chega via realtime antes do
 *    invalidate de reconciliação — sem isso o balão duplicaria por ~1s).
 */
export function appendRealtimeMessage(
  old: WaMessage[] | undefined,
  nova: WaMessage,
): WaMessage[] | undefined {
  if (!old) return undefined;
  if (old.some((m) => m.id === nova.id)) return old;

  if (nova.direction === 'out') {
    const idx = old.findIndex((m) => isOptimisticMessage(m) && m.body === nova.body);
    if (idx >= 0) {
      const next = old.slice();
      next.splice(idx, 1);
      next.push(nova);
      return next;
    }
  }
  return [...old, nova];
}

/**
 * PREPEND de uma página de histórico ("carregar mensagens anteriores") no
 * cache da thread. A página chega em ordem ASC (já revertida pelo caller).
 *
 * O fetch da página usa `.lte(created_at_da_mais_antiga)` — NÃO `.lt` — pra
 * não perder mensagens irmãs com o MESMO timestamp do cursor que ficaram fora
 * da janela anterior; o preço são duplicatas re-baixadas, descartadas aqui
 * pelo dedupe por id. `added` permite ao caller detectar fim de histórico e
 * falta de progresso (guard anti-loop do caso patológico de empate em massa).
 */
export function prependOlderMessages(
  old: WaMessage[] | undefined,
  pagina: WaMessage[],
): { next: WaMessage[] | undefined; added: number } {
  if (!old) return { next: undefined, added: 0 };
  const ids = new Set(old.map((m) => m.id));
  const novas = pagina.filter((m) => !ids.has(m.id));
  if (novas.length === 0) return { next: old, added: 0 };
  return { next: [...novas, ...old], added: novas.length };
}

/**
 * Merge do refetch da thread com o cache anterior: o refetch baixa SÓ a
 * janela recente (últimas THREAD_LIMIT), mas o cache pode conter HISTÓRICO
 * carregado via "mensagens anteriores" — sem este merge, o invalidate de
 * reconciliação do envio (useSendWhatsapp.onSuccess) descartaria o histórico
 * carregado e a tela "pularia" de volta pras últimas 100.
 *
 * Mantém do cache anterior só mensagens REAIS (otimista órfã continua
 * morrendo no refetch, comportamento de antes) anteriores-ou-iguais ao início
 * da janela (`<=` + dedupe por id: empate de timestamp na borda não some), e
 * cola a janela fresca por cima. created_at é ISO uniforme do PostgREST →
 * comparação lexicográfica é segura.
 */
export function mergeThreadWindow(
  prev: WaMessage[] | undefined,
  janelaRecente: WaMessage[],
): WaMessage[] {
  if (!prev || prev.length === 0 || janelaRecente.length === 0) return janelaRecente;
  const ids = new Set(janelaRecente.map((m) => m.id));

  // Guard anti-buraco (revisão adversarial): janela CHEIA sem NENHUM id em
  // comum com o cache = impossível provar continuidade — o realtime pode ter
  // perdido >THREAD_LIMIT mensagens (canal morto, aba suspensa) e costurar
  // [antigas + janela] renderizaria a conversa com um BURACO invisível no
  // meio, que nem o botão de histórico cura (o cursor é a mais antiga).
  // Nesse caso, descarta o cache (comportamento pré-merge: pula pras últimas
  // 100, sem buraco). Em operação saudável o overlap é sempre ≥1.
  if (janelaRecente.length >= THREAD_LIMIT && !prev.some((m) => ids.has(m.id))) {
    return janelaRecente;
  }

  const inicioJanela = janelaRecente[0].created_at;
  const fimJanela = janelaRecente[janelaRecente.length - 1].created_at;
  const antigasReais = prev.filter(
    (m) => !isOptimisticMessage(m) && !ids.has(m.id) && m.created_at <= inicioJanela,
  );
  // Sufixo: mensagens REAIS do cache mais novas que a janela — são appends do
  // realtime que chegaram DURANTE o RTT do refetch (o SELECT já tinha tirado
  // o snapshot). Sem isto, o merge descartava a INBOUND do cliente chegada
  // nessa janela (~100-400ms) e ela sumia da tela até o próximo refetch. A
  // tabela é append-only → não há risco de ressuscitar mensagem apagada.
  const novasReais = prev.filter(
    (m) => !isOptimisticMessage(m) && !ids.has(m.id) && m.created_at > fimJanela,
  );
  if (antigasReais.length === 0 && novasReais.length === 0) return janelaRecente;
  return [...antigasReais, ...janelaRecente, ...novasReais];
}
