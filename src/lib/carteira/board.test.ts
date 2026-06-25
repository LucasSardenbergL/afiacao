import { describe, it, expect } from 'vitest';
import { healthBadge, montarColunasBoard } from './board';

describe('carteira/board', () => {
  it('healthBadge usa tokens de status', () => {
    expect(healthBadge('critico').className).toContain('text-status-error');
    expect(healthBadge('saudavel').label).toBe('Saudável');
  });

  it('monta 3 colunas na ordem risco/expansao/follow_up (vazias)', () => {
    const cols = montarColunasBoard([], [], []);
    expect(cols.map((c) => c.tipo)).toEqual(['risco', 'expansao', 'follow_up']);
    expect(cols.every((c) => c.cards.length === 0)).toBe(true);
  });

  it('cruza agenda × scores × sla no card', () => {
    const agenda = [
      { customer_user_id: 'a', customer_name: 'Cliente A', priorityScore: 80, agendaType: 'risco' as const, healthClass: 'critico' },
      { customer_user_id: 'b', customer_name: 'Cliente B', priorityScore: 50, agendaType: 'expansao' as const, healthClass: 'saudavel' },
    ];
    const scores = [
      { customer_user_id: 'a', customer_name: 'Cliente A', customer_phone: '11999', healthClass: 'critico', churnRisk: 90, priorityScore: 80 },
      { customer_user_id: 'b', customer_name: 'Cliente B', customer_phone: null, healthClass: 'saudavel', churnRisk: 5, priorityScore: 50 },
    ] as never[];
    const sla = [{ customer_user_id: 'a', vencido: true, dias_sem_contato: 30 }] as never[];
    const cols = montarColunasBoard(agenda as never[], scores, sla);
    const risco = cols.find((c) => c.tipo === 'risco')!;
    expect(risco.cards).toHaveLength(1);
    expect(risco.cards[0]).toMatchObject({ nome: 'Cliente A', phone: '11999', churnRisk: 90, slaVencido: true, diasSemContato: 30 });
    const exp = cols.find((c) => c.tipo === 'expansao')!;
    expect(exp.cards[0]).toMatchObject({ nome: 'Cliente B', slaVencido: false, diasSemContato: null });
  });
});
