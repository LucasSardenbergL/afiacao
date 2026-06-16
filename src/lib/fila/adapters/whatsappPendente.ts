// ⚠️ NÃO LIGADO no v1 (Fase 1). A fonte "WhatsApp pendente" foi adiada p/ a Fase 3 (split):
// esta versão tem falso-negativo (cap 200 do inbox + proxy last_message_at, Codex P1).
// Na Fase 3, reescrever sobre query/RPC de pendentes (sem cap) com last_outbound_at real. Ver spec §4.
import type { AcaoSugerida, AcaoPayload } from '../types';

/** Conversa do inbox aguardando resposta da vendedora, dentro da janela de 24h. */
export interface WaPendente {
  conversationId: string;
  clienteUserId: string | null;
  nome: string | null;
  telefone: string | null;
  /** horas desde a última mensagem do cliente (inbound) ainda sem resposta */
  horasDesde: number;
}

export function whatsappPendenteParaAcoes(pendentes: WaPendente[]): AcaoSugerida[] {
  return pendentes.map(p => ({
    fonte: 'whatsapp_pendente' as const,
    entidadeId: p.conversationId,
    clienteUserId: p.clienteUserId,
    clienteNome: p.nome,
    telefone: p.telefone,
    acao: 'Responder',
    titulo: `Responder ${p.nome ?? p.telefone ?? 'cliente'} no WhatsApp`,
    motivo: `Cliente respondeu há ${Math.round(p.horasDesde)}h e ninguém retornou`,
    categoria: 'prazo' as const,
    score: Math.max(0, Math.min(1, p.horasDesde / 24)),
    valorEsperado: null,
    tipoValor: 'sem_valor' as const,
    cta: 'whatsapp' as const,
    dedupeKey: `${p.clienteUserId ?? p.conversationId}:whatsapp`,
    payload: { kind: 'whatsapp', conversationId: p.conversationId } satisfies AcaoPayload,
  }));
}
