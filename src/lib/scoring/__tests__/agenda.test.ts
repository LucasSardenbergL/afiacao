import { describe, it, expect } from 'vitest';
import {
  signalPriorityNudge,
  effectivePriority,
  buildAgendaItems,
  type CarteiraRow,
} from '../agenda';
import type { ScoreAdjustment } from '../types';

function mkAdjustment(overrides: Partial<ScoreAdjustment> = {}): ScoreAdjustment {
  return {
    churn_delta: 0,
    expansion_delta: 0,
    health_delta: 0,
    eff_delta: 0,
    breakdown: { churn: [], expansion: [], health: [], eff: [] },
    computed_at: '',
    source_call_count: 0,
    ...overrides,
  };
}

function mkRow(overrides: Partial<CarteiraRow> = {}): CarteiraRow {
  return {
    customer_user_id: 'c1',
    priority_score: 50,
    churn_risk: 0,
    expansion_score: 0,
    health_class: 'estavel',
    signal_modifiers: null,
    sales_history_status: 'ativo',
    ...overrides,
  };
}

describe('signalPriorityNudge', () => {
  it('null → 0', () => {
    expect(signalPriorityNudge(null)).toBe(0);
  });

  it('{} (default vazio sem breakdown) → 0, não quebra', () => {
    const empty = {} as unknown as ScoreAdjustment;
    expect(() => signalPriorityNudge(empty)).not.toThrow();
    expect(signalPriorityNudge(empty)).toBe(0);
  });

  it('soma ponderada churn*0.5 + expansion*0.5 + eff*0.3', () => {
    const mods = mkAdjustment({ churn_delta: 20, expansion_delta: 10, eff_delta: -5 });
    // 20*0.5 + 10*0.5 + (-5)*0.3 = 10 + 5 - 1.5 = 13.5
    expect(signalPriorityNudge(mods)).toBeCloseTo(13.5, 5);
  });
});

describe('effectivePriority', () => {
  it('base + nudge, clampado 0..100', () => {
    expect(effectivePriority(50, mkAdjustment({ churn_delta: 20 }))).toBe(60);
    expect(effectivePriority(95, mkAdjustment({ churn_delta: 40 }))).toBe(100); // clamp topo
    expect(effectivePriority(5, mkAdjustment({ eff_delta: -40 }))).toBe(0); // clamp base
  });

  it('base sem sinal = base', () => {
    expect(effectivePriority(42, null)).toBe(42);
  });
});

describe('buildAgendaItems', () => {
  it('não quebra com signal_modifiers = {} e conta 0 sinais', () => {
    const empty = {} as unknown as ScoreAdjustment;
    const items = buildAgendaItems([mkRow({ signal_modifiers: empty })], 10);
    expect(items).toHaveLength(1);
    expect(items[0].signalsCount).toBe(0);
    expect(items[0].topModifier).toBeNull();
  });

  it('classifica risco com churn na escala 0..100 (> 50, não > 0.5)', () => {
    const baixoChurn = buildAgendaItems([mkRow({ churn_risk: 30, health_class: 'estavel' })])[0];
    const altoChurn = buildAgendaItems([mkRow({ churn_risk: 70, health_class: 'estavel' })])[0];
    expect(baixoChurn.agenda_type).toBe('follow_up'); // 30 não é risco
    expect(altoChurn.agenda_type).toBe('risco'); // 70 é risco
  });

  it('classifica expansao com expansion > 50', () => {
    const item = buildAgendaItems([mkRow({ churn_risk: 10, expansion_score: 70, health_class: 'estavel' })])[0];
    expect(item.agenda_type).toBe('expansao');
  });

  it('re-ordena por prioridade EFETIVA (base + nudge), não só base', () => {
    const rows = [
      mkRow({ customer_user_id: 'base-alto', priority_score: 60, signal_modifiers: null }),
      mkRow({ customer_user_id: 'sinal-forte', priority_score: 55, signal_modifiers: mkAdjustment({ expansion_delta: 30 }) }),
    ];
    const items = buildAgendaItems(rows, 10);
    // sinal-forte: 55 + 30*0.5 = 70 > base-alto 60 → deve vir primeiro
    expect(items[0].customer_user_id).toBe('sinal-forte');
    expect(items[0].priority_score).toBeCloseTo(70, 5);
    expect(items[1].customer_user_id).toBe('base-alto');
  });

  it('respeita o limit', () => {
    const rows = Array.from({ length: 20 }, (_, i) => mkRow({ customer_user_id: `c${i}`, priority_score: i }));
    expect(buildAgendaItems(rows, 5)).toHaveLength(5);
  });

  it('sem_historico NÃO vira risco mesmo com churn alto/health crítico → "ativacao"', () => {
    const item = buildAgendaItems([mkRow({ churn_risk: 95, health_class: 'critico', sales_history_status: 'sem_historico' })])[0];
    expect(item.agenda_type).toBe('ativacao');
  });

  it('guard de slot ESTRUTURAL: ativação NÃO desloca recuperação mesmo com prioridade MAIOR', () => {
    const items = buildAgendaItems([
      mkRow({ customer_user_id: 'prospect', priority_score: 100, health_class: 'novo', sales_history_status: 'sem_historico' }),
      mkRow({ customer_user_id: 'risco', priority_score: 99, churn_risk: 80, health_class: 'critico', sales_history_status: 'stale' }),
    ], 1);
    // risco (99) ocupa o único slot, apesar de a ativação (100) ter prioridade efetiva MAIOR
    expect(items[0].customer_user_id).toBe('risco');
    expect(items[0].agenda_type).toBe('risco');
  });

  it('carteira só-prospect: ativação preenche a agenda (não há recuperação a fazer)', () => {
    const items = buildAgendaItems([
      mkRow({ customer_user_id: 'p1', priority_score: 30, sales_history_status: 'sem_historico' }),
      mkRow({ customer_user_id: 'p2', priority_score: 40, sales_history_status: 'sem_historico' }),
    ], 5);
    expect(items.map((i) => i.agenda_type)).toEqual(['ativacao', 'ativacao']);
    expect(items[0].customer_user_id).toBe('p2'); // ordenado por prioridade DENTRO do bucket
  });

  it('ativo/stale mantêm a classificação atual (risco)', () => {
    const item = buildAgendaItems([mkRow({ churn_risk: 70, health_class: 'estavel', sales_history_status: 'ativo' })])[0];
    expect(item.agenda_type).toBe('risco');
  });
});
