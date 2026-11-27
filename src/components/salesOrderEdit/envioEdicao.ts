// Desfechos do salvar da edição que valem para além do toast (revisão /sales, leva 1: #16 e #30).
import type { QueryClient } from '@tanstack/react-query';

/**
 * Prazos do salvar (Codex 2026-11-26): sem eles, uma resposta cujo corpo nunca fecha deixava o envio "em voo"
 * para sempre — e a tela do pedido presa em "carregando". A edge tem teto de ~150 s; passou disso, o desfecho
 * é desconhecido. Objeto mutável só para os testes encurtarem.
 */
export const PRAZOS = { envioMs: 180_000, corpoMs: 10_000 };

/** `{ ok: false }` se a promessa não terminar no prazo (ela segue rodando; o resultado é descartado). */
export async function comPrazo<T>(p: Promise<T>, ms: number): Promise<{ ok: true; valor: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const venceu = new Promise<{ ok: false }>((r) => { timer = setTimeout(() => r({ ok: false }), ms); });
  try {
    return await Promise.race([p.then((valor) => ({ ok: true as const, valor })), venceu]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Por que o formulário não pode ser reenviado.
 * • `concorrente`: a edge recusou ANTES de tocar o Omie porque o pedido mudou (versão, envio, exclusão) —
 *   recarregar traz a versão atual e destrava.
 * • `divergente`: a falha veio DEPOIS de a edge reservar o pedido, ou o desfecho é desconhecido (resposta
 *   perdida, edge antiga sem a marca). O Omie pode estar diferente do app; recarregar relê o app, não o Omie,
 *   e reabilitaria o carrinho velho (Codex 2026-11-26) — por isso NÃO destrava nesta tela.
 */
export type TravaDoEnvio = { tipo: 'concorrente' | 'divergente'; mensagem: string };

export const TRAVA_CONCORRENTE: TravaDoEnvio = {
  tipo: 'concorrente',
  mensagem: 'O pedido mudou desde que esta tela foi aberta. Nada foi alterado no Omie — recarregue o pedido para ver a versão atual antes de editar.',
};

export const TRAVA_DIVERGENTE: TravaDoEnvio = {
  tipo: 'divergente',
  mensagem: 'O Omie pode ter sido alterado e o app não conseguiu confirmar como o pedido ficou. Confira o pedido direto no Omie — esta tela não salva mais este pedido, para não regravar a versão antiga por cima.',
};

/**
 * CANCELA antes de invalidar: um pré-carregamento do detalhe iniciado na lista e ainda em voo terminaria
 * DEPOIS da invalidação e gravaria o valor antigo como fresco por 60 s — que a impressão e o WhatsApp leem
 * (Codex 2026-11-26, reproduzido R$ 100 → R$ 150 → leitura de R$ 100). Lista e soma por prefixo; detalhe e
 * descontos só os DESTE pedido (cancelar por prefixo interrompia a leitura do cupom de outro pedido).
 * O chamador não espera: o refetch de uma consulta ativa não segura a navegação.
 */
export async function invalidarCachesDoPedido(
  queryClient: Pick<QueryClient, 'invalidateQueries' | 'cancelQueries'>,
  pedidoId: string,
): Promise<void> {
  const filtros = [
    { queryKey: ['order-feed'] },
    { queryKey: ['order-feed-total'] },
    // orderDetailQueryKey = ['order-detail', userId, origin, id]; descontosItensQueryKey = [..., userId, id]
    { queryKey: ['order-detail'], predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[3] === pedidoId },
    { queryKey: ['order-descontos-itens'], predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[2] === pedidoId },
  ];
  await Promise.all(filtros.map((f) => queryClient.cancelQueries(f)));
  await Promise.all(filtros.map((f) => queryClient.invalidateQueries(f)));
}

/**
 * Lê UMA vez, com prazo, o corpo da falha do `alterar_pedido` (Codex 2026-11-26: duas leituras de 10 s
 * seguravam o envio por 20 s). Devolve a mensagem da edge e se o formulário pode ser reenviado.
 * Só é "tentar de novo é seguro" com PROVA: `precisa_recarregar: false` (falhou antes da reserva) ou 401/403
 * (gate de autenticação, antes da ação — a ação só responde 200/500). Sem a prova — `true`, corpo sem a chave
 * (edge antiga), não-JSON, que não fecha no prazo ou resposta que nem chegou — o desfecho é desconhecido.
 */
export async function lerFalhaDoEnvio(err: unknown): Promise<{ mensagem: string | null; exigeRecarregar: boolean }> {
  const ctx = (err as { context?: unknown } | null)?.context;
  if (!ctx || typeof (ctx as Response).clone !== 'function') return { mensagem: null, exigeRecarregar: true };
  const status = (ctx as Response).status;
  const antesDaAcao = status === 401 || status === 403;
  let lido: { ok: true; valor: unknown } | { ok: false };
  try {
    lido = await comPrazo((ctx as Response).clone().json() as Promise<unknown>, PRAZOS.corpoMs);
  } catch {
    return { mensagem: null, exigeRecarregar: !antesDaAcao };
  }
  if (!lido.ok) return { mensagem: null, exigeRecarregar: !antesDaAcao };
  const corpo = lido.valor && typeof lido.valor === 'object' ? lido.valor as Record<string, unknown> : {};
  const mensagem = typeof corpo.error === 'string' ? corpo.error : typeof corpo.mensagem === 'string' ? corpo.mensagem : null;
  return { mensagem, exigeRecarregar: !antesDaAcao && corpo.precisa_recarregar !== false };
}
