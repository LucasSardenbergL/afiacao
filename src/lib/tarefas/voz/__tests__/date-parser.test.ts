// src/lib/tarefas/voz/__tests__/date-parser.test.ts
import { describe, it, expect } from 'vitest';
import { resolverDataPtBr } from '../date-parser';

const QUI = '2026-06-04'; // quinta-feira
const SEX = '2026-06-05'; // sexta-feira

describe('resolverDataPtBr', () => {
  it('sem frase → sem_data, próxima interação (ligação)', () => {
    expect(resolverDataPtBr(null, QUI)).toEqual({ modo: 'interacao', due_date: null, interacao_tipo: 'ligacao', status: 'sem_data' });
    expect(resolverDataPtBr('   ', QUI).status).toBe('sem_data');
  });

  it('hoje / amanhã / depois de amanhã', () => {
    expect(resolverDataPtBr('hoje', QUI)).toMatchObject({ due_date: '2026-06-04', status: 'resolvida', modo: 'data' });
    expect(resolverDataPtBr('amanhã', QUI).due_date).toBe('2026-06-05');
    expect(resolverDataPtBr('amanha', QUI).due_date).toBe('2026-06-05');
    expect(resolverDataPtBr('depois de amanhã', QUI).due_date).toBe('2026-06-06');
  });

  it('dia da semana — quinta falando sexta → próxima sexta (06-05)', () => {
    expect(resolverDataPtBr('sexta', QUI).due_date).toBe('2026-06-05');
    expect(resolverDataPtBr('sexta-feira', QUI).due_date).toBe('2026-06-05');
  });

  it('"sexta que vem" → +7 sobre a próxima sexta (06-12)', () => {
    expect(resolverDataPtBr('sexta que vem', QUI).due_date).toBe('2026-06-12');
  });

  it('"hoje conta": sexta falando "sexta" → hoje', () => {
    expect(resolverDataPtBr('sexta', SEX).due_date).toBe('2026-06-05');
  });

  it('segunda / segunda da semana que vem', () => {
    expect(resolverDataPtBr('segunda', QUI).due_date).toBe('2026-06-08');
    expect(resolverDataPtBr('segunda da semana que vem', QUI).due_date).toBe('2026-06-15');
  });

  it('"dia N": futuro neste mês; se já passou, próximo mês', () => {
    expect(resolverDataPtBr('dia 15', QUI).due_date).toBe('2026-06-15');
    expect(resolverDataPtBr('dia 2', QUI).due_date).toBe('2026-07-02'); // 2 < 4 → próximo mês
    expect(resolverDataPtBr('dia 4', QUI)).toMatchObject({ due_date: '2026-06-04', status: 'resolvida' }); // hoje conta, não 'passado'
  });

  it('"dia N" inexistente no mês → clamp ao último dia', () => {
    expect(resolverDataPtBr('dia 31', '2026-09-10').due_date).toBe('2026-09-30'); // setembro tem 30
  });

  it('fim do mês → último dia', () => {
    expect(resolverDataPtBr('fim do mês', QUI).due_date).toBe('2026-06-30');
  });

  it('"semana que vem" / "mês que vem" SEM dia → ambígua (não chuta)', () => {
    expect(resolverDataPtBr('semana que vem', QUI).status).toBe('ambigua');
    expect(resolverDataPtBr('mês que vem', QUI).status).toBe('ambigua');
  });

  it('frase de data não reconhecida → nao_resolvida', () => {
    expect(resolverDataPtBr('quando der', QUI).status).toBe('nao_resolvida');
  });
});
