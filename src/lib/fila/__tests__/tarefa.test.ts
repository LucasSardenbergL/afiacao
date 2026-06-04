import { describe, it, expect } from 'vitest';
import { tarefasParaAcoes } from '../adapters/tarefa';
import type { TarefaEstado } from '@/lib/tarefas/types';

function tarefa(p: Partial<TarefaEstado>): TarefaEstado {
  return {
    id: 't1', descricao: 'Ligar pro cliente', categoria: 'ligar', customer_user_id: 'c1',
    assigned_to: 'v1', created_by: 'founder', empresa: 'oben', modo: 'data', due_date: null,
    interacao_tipo: null, backstop_days: 7, tolerancia_dias: 1, adiada_para: null,
    motivo_adiamento: null, auto_satisfy_mode: 'off', target_produto_id: null, target_texto: null,
    target_preco_centavos: null, status: 'aberta', concluida_em: null, concluida_por: null,
    conclusao_origem: null, nota_conclusao: null, escalado_em: null, effective_due: '2026-06-04',
    responsavel_efetivo: 'v1', atrasada: false, escalavel: false, tem_sugestao_pendente: false, ...p,
  };
}

describe('tarefasParaAcoes', () => {
  it('mapeia tarefa aberta para categoria prazo, sem valor', () => {
    const [a] = tarefasParaAcoes([tarefa({})]);
    expect(a.fonte).toBe('tarefa');
    expect(a.categoria).toBe('prazo');
    expect(a.valorEsperado).toBeNull();
    expect(a.tipoValor).toBe('sem_valor');
    expect(a.clienteUserId).toBe('c1');
    expect(a.dedupeKey).toBe('c1:tarefa:t1');
    expect(a.payload).toEqual({ kind: 'tarefa', tarefaId: 't1' });
  });

  it('atrasada tem score maior e motivo de atraso', () => {
    const [normal] = tarefasParaAcoes([tarefa({ id: 'a', atrasada: false })]);
    const [atrasada] = tarefasParaAcoes([tarefa({ id: 'b', atrasada: true })]);
    expect(atrasada.score).toBeGreaterThan(normal.score);
    expect(atrasada.motivo).toMatch(/atras/i);
  });

  it('ignora tarefas não-abertas', () => {
    expect(tarefasParaAcoes([tarefa({ status: 'concluida' })])).toHaveLength(0);
  });

  it('mapeia categoria->cta (oferecer vira pedido, ligar vira ligar)', () => {
    expect(tarefasParaAcoes([tarefa({ categoria: 'oferecer' })])[0].cta).toBe('pedido');
    expect(tarefasParaAcoes([tarefa({ categoria: 'ligar' })])[0].cta).toBe('ligar');
    expect(tarefasParaAcoes([tarefa({ categoria: 'whatsapp' })])[0].cta).toBe('whatsapp');
  });
});
