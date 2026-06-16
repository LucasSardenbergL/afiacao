import type { RouteContactItem } from '@/queries/useRouteContactList';
import type { AcaoSugerida, AcaoPayload } from '../types';

export function rotaParaAcoes(callQueue: RouteContactItem[], dataRota: string): AcaoSugerida[] {
  return callQueue.map(c => ({
    fonte: 'rota' as const,
    entidadeId: c.customerUserId,
    clienteUserId: c.customerUserId,
    clienteNome: c.name,
    telefone: c.phone,
    acao: 'Ligar',
    titulo: `Ligar para ${c.name}`,
    motivo: 'Cidade da rota de hoje · recompra provável',
    categoria: 'esperado' as const,
    score: c.prontidao ?? 0.5,
    valorEsperado: Number.isFinite(c.valorDaLigacao) ? c.valorDaLigacao : null,
    tipoValor: 'estimado' as const,
    cta: 'ligar' as const,
    dedupeKey: `${c.customerUserId}:ligar`,
    payload: {
      kind: 'rota',
      customerUserId: c.customerUserId,
      dataRota,
      bucket: c.bucket,
      valor: Number.isFinite(c.valorDaLigacao) ? c.valorDaLigacao : null,
    } satisfies AcaoPayload,
  }));
}
