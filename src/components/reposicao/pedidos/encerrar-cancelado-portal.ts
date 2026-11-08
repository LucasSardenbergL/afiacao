// 5.3 — "Encerrar — cancelado no fornecedor": regras da TELA (quando oferecer o botão) e leitura da resposta da edge
// `sayerlack-encerrar-cancelado-portal`. Quem DECIDE é o banco (RPC sob FOR UPDATE); aqui só se evita oferecer o
// botão onde ele certamente seria recusado.
import type { PedidoSugerido } from './types';

/** Sem PO = null, vazio ou '0' (a mesma regra da varredura e do banco). */
function semPo(id: string | null | undefined): boolean {
  const v = (id ?? '').trim();
  return v === '' || v === '0';
}

/** O pedido está no caso da 5.3: aceito no portal, sem PO, aguardando disparo, e a última leitura do SEU protocolo é 6. */
export function podeOferecerEncerrar(p: PedidoSugerido | null): boolean {
  if (!p) return false;
  const protocolo = (p.portal_protocolo ?? '').trim();
  return (
    p.empresa === 'OBEN' &&
    protocolo !== '' &&
    (p.status === 'aprovado_aguardando_disparo' || p.status === 'falha_envio') &&
    p.status_envio_portal === 'sucesso_portal' &&
    semPo(p.omie_pedido_compra_id) &&
    p.portal_situacao_codigo === '6' &&
    (p.portal_situacao_protocolo ?? '') === protocolo
  );
}

type DesfechoEncerrar = 'encerrado' | 'recusado' | 'indeterminado' | 'erro';

export interface ResultadoEncerrar {
  desfecho: DesfechoEncerrar;
  mensagem: string;
}

/**
 * Resposta da edge (2xx ou o corpo de um não-2xx). Sem contrato reconhecido = "não sei" — nunca "encerrado" e
 * nunca "nada aconteceu": a tela manda reabrir o pedido para conferir.
 */
export function interpretarRespostaEncerrar(corpo: unknown, http: number | null): ResultadoEncerrar {
  const b = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? (corpo as Record<string, unknown>) : null;
  const mensagem = typeof b?.mensagem === 'string' && b.mensagem.trim() ? b.mensagem : null;
  const desfecho = b?.desfecho;
  if (desfecho === 'encerrado' && b?.ok === true) {
    return { desfecho: 'encerrado', mensagem: mensagem ?? 'Pedido encerrado como cancelado no fornecedor.' };
  }
  if (desfecho === 'recusado' || desfecho === 'indeterminado') {
    return { desfecho, mensagem: mensagem ?? 'Encerramento não feito.' };
  }
  if (http === 401 || http === 403) {
    return { desfecho: 'recusado', mensagem: 'Só um usuário master encerra pedido cancelado no fornecedor.' };
  }
  if (http === 400 && mensagem) return { desfecho: 'recusado', mensagem };
  return {
    desfecho: 'erro',
    mensagem: (mensagem ?? `Sem resposta reconhecível do servidor${http ? ` (HTTP ${http})` : ''}.`) +
      ' Reabra o pedido para conferir se ele foi encerrado.',
  };
}
