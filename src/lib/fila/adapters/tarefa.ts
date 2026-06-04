import type { TarefaEstado, TarefaCategoria } from '@/lib/tarefas/types';
import type { AcaoSugerida, AcaoPayload, TipoCta } from '../types';

const CTA_POR_CATEGORIA: Record<TarefaCategoria, TipoCta> = {
  ligar: 'ligar', whatsapp: 'whatsapp', oferecer: 'pedido', preco: 'pedido', outro: 'tarefa',
};
const VERBO_POR_CATEGORIA: Record<TarefaCategoria, string> = {
  ligar: 'Ligar', whatsapp: 'Responder', oferecer: 'Oferecer', preco: 'Revisar preço', outro: 'Cobrar',
};

export function tarefasParaAcoes(tarefas: TarefaEstado[]): AcaoSugerida[] {
  return tarefas
    .filter(t => t.status === 'aberta')
    .map(t => ({
      fonte: 'tarefa' as const,
      entidadeId: t.id,
      clienteUserId: t.customer_user_id,
      clienteNome: null,
      telefone: null,
      acao: VERBO_POR_CATEGORIA[t.categoria],
      titulo: t.descricao,
      motivo: t.atrasada ? 'Tarefa atrasada — seu chefe pediu' : 'Tarefa do seu chefe',
      categoria: 'prazo' as const,
      score: t.atrasada ? 1 : 0.6,
      valorEsperado: null,
      tipoValor: 'sem_valor' as const,
      cta: CTA_POR_CATEGORIA[t.categoria],
      dedupeKey: `${t.customer_user_id}:tarefa:${t.id}`,
      payload: { kind: 'tarefa', tarefaId: t.id } satisfies AcaoPayload,
    }));
}
