// Desfechos do salvar da edição que valem para além do toast (revisão /sales, leva 1: #16 e #30).
import type { QueryClient } from '@tanstack/react-query';

/**
 * Prazos do salvar (Codex 2026-11-26): sem eles, uma resposta cujo corpo nunca fecha deixava o envio "em voo"
 * para sempre — e a tela do pedido presa em "carregando". A edge tem teto de ~150 s; passou disso, o desfecho
 * é desconhecido. Objeto mutável só para os testes encurtarem.
 */
export const PRAZOS = { envioMs: 180_000, corpoMs: 10_000, reconsultaMs: 5_000, reconsultas: 4 };

/** UUID v4 do salvamento. `crypto.randomUUID` só existe em contexto seguro (HTTPS/localhost): pelo IP da rede local
 *  ele falta, e `getRandomValues` (disponível em qualquer contexto) monta o mesmo formato (Codex r6). */
export function novoTokenDeEnvio(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

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

export const TRAVA_EM_CURSO: TravaDoEnvio = {
  tipo: 'concorrente',
  mensagem: 'Este pedido está sendo salvo agora em outra aba ou aparelho. Aguarde alguns minutos e recarregue o pedido antes de editar.',
};

/** O banco diz que ESTE salvamento ainda está no Omie (despachado, sem desfecho): nem sucesso, nem divergência. */
export const TRAVA_EM_ANDAMENTO: TravaDoEnvio = {
  tipo: 'concorrente',
  mensagem: 'O Omie ainda está processando este salvamento. Recarregue o pedido em alguns minutos para ver como ele ficou — não salve de novo antes disso.',
};

export const TRAVA_POSSE_ILEGIVEL: TravaDoEnvio = {
  tipo: 'concorrente',
  mensagem: 'Não consegui conferir se este pedido está sendo salvo em outro lugar. Recarregue o pedido antes de editar.',
};

/** Divergência durável no banco (migration 20261127120100): o token é o que o master precisa para liberar. */
export type DivergenciaDuravel = { token: string; motivo: string | null };

/**
 * Lê `pedido_edicao_omie_estado` ao abrir a tela — a posse é do PEDIDO (conta, PV), não desta aba: vale
 * entre abas e aparelhos e sobrevive à recarga. Fail-closed: erro ou forma desconhecida TRAVA (sem a leitura
 * não dá para provar que não há edição em voo).
 */
export function travaDaPosse(resp: { data: unknown; error: unknown }): {
  trava: TravaDoEnvio | null;
  divergencia: DivergenciaDuravel | null;
} {
  if (resp.error) return { trava: TRAVA_POSSE_ILEGIVEL, divergencia: null };
  const d = resp.data && typeof resp.data === 'object' ? resp.data as Record<string, unknown> : null;
  switch (d?.situacao) {
    case 'livre':
    case 'ausente':
      return { trava: null, divergencia: null };
    case 'reservada':
    case 'em_voo':
      return { trava: TRAVA_EM_CURSO, divergencia: null };
    case 'divergente':
      return {
        trava: TRAVA_DIVERGENTE,
        divergencia: typeof d.token === 'string'
          ? { token: d.token, motivo: typeof d.motivo === 'string' ? d.motivo : null }
          : null,
      };
    default:
      return { trava: TRAVA_POSSE_ILEGIVEL, divergencia: null };
  }
}

/**
 * Desfecho de UM salvamento pelo banco (`pedido_edicao_omie_encerrar_envio`), quando a resposta da edge se
 * perdeu ou não prova nada (#30; Codex no desenho do PR 2). A RPC ENCERRA o token: se a edge ainda não
 * despachou, nada desse save vai mais ao Omie — "não alterou" vira fato. Só `concluida` é sucesso; só
 * abandonada/liberada/expirada (e pedido sem PV/ausente) provam que nada mudou; `em_voo` = ainda no Omie (a tela
 * reconsulta e, se seguir assim, manda recarregar depois — o banco decide na abertura); `resolvida` = decidido por
 * um master; o resto — divergente, leitura que falhou ou forma desconhecida — é divergente (fail-closed). A resposta
 * `success: true` que chegue DEPOIS disto é descartada (`comPrazo`): o banco já respondeu.
 */
export function desfechoDoEnvioPeloBanco(resp: { data: unknown; error: unknown }): 'concluido' | 'nao_alterado' | 'em_voo' | 'resolvido' | 'divergente' {
  if (resp.error) return 'divergente';
  switch (resp.data) {
    case 'concluida':
      return 'concluido';
    case 'em_voo':
      return 'em_voo';
    // Um master conferiu no Omie e liberou: o token está DECIDIDO (não fica pendente), mas a tela que o enviou não
    // sabe como o pedido ficou — trava até reler.
    case 'resolvida':
      return 'resolvido';
    case 'abandonada':
    case 'liberada':
    case 'expirada':
    case 'sem_pv':
    case 'ausente':
      return 'nao_alterado';
    default:
      return 'divergente';
  }
}

/**
 * CANCELA antes de invalidar: um pré-carregamento do detalhe iniciado na lista e ainda em voo terminaria
 * DEPOIS da invalidação e gravaria o valor antigo como fresco por 60 s — que a impressão e o WhatsApp leem
 * (Codex 2026-11-26, reproduzido R$ 100 → R$ 150 → leitura de R$ 100). Lista e soma por prefixo; detalhe e
 * descontos só os DESTE pedido (cancelar por prefixo interrompia a leitura do cupom de outro pedido).
 * O chamador não espera: o refetch de uma consulta ativa não segura a navegação.
 */
const canonico = (v: unknown) => (typeof v === 'string' ? v.toLowerCase().replace(/[^0-9a-f]/g, '') : null);
const mesmoPedido = (a: unknown, b: string) => { const x = canonico(a); return x !== null && x !== '' && x === canonico(b); };

export async function invalidarCachesDoPedido(
  queryClient: Pick<QueryClient, 'invalidateQueries' | 'cancelQueries'>,
  pedidoId: string,
): Promise<void> {
  const filtros = [
    { queryKey: ['order-feed'] },
    { queryKey: ['order-feed-total'] },
    // orderDetailQueryKey = ['order-detail', userId, origin, id]; descontosItensQueryKey = [..., userId, id]
    // Pela forma CANÔNICA do UUID nos dois lados: a rota aceita maiúsculas/sem hífen, a lista usa o do banco (Codex r4).
    { queryKey: ['order-detail'], predicate: (q: { queryKey: readonly unknown[] }) => mesmoPedido(q.queryKey[3], pedidoId) },
    { queryKey: ['order-descontos-itens'], predicate: (q: { queryKey: readonly unknown[] }) => mesmoPedido(q.queryKey[2], pedidoId) },
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
