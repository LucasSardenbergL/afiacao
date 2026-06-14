import { describe, it, expect } from 'vitest';
import {
  defaultContextForRole,
  nextModeForContext,
  dedupeStopsById,
  particionarAlvos,
  filtrarAlvos,
  toggleTarget,
} from './field-targets';
import type { RouteStop } from '@/components/reposicao/routePlanner/types';

describe('defaultContextForRole', () => {
  it('master abre no contexto campo (caça)', () => {
    expect(defaultContextForRole(true)).toBe('campo');
  });
  it('não-master (gestor/staff) abre no contexto equipe', () => {
    expect(defaultContextForRole(false)).toBe('equipe');
  });
});

describe('nextModeForContext', () => {
  it('contexto campo força o modo prospecção', () => {
    expect(nextModeForContext('campo', 'hibrido')).toBe('prospeccao');
    expect(nextModeForContext('campo', 'manual')).toBe('prospeccao');
  });
  it('voltar pra equipe troca prospecção por híbrido (default operacional)', () => {
    expect(nextModeForContext('equipe', 'prospeccao')).toBe('hibrido');
  });
  it('voltar pra equipe preserva um modo de equipe já escolhido', () => {
    expect(nextModeForContext('equipe', 'logistica')).toBe('logistica');
    expect(nextModeForContext('equipe', 'comercial')).toBe('comercial');
    expect(nextModeForContext('equipe', 'hibrido')).toBe('hibrido');
    expect(nextModeForContext('equipe', 'manual')).toBe('manual');
  });
});

describe('dedupeStopsById', () => {
  it('remove ids repetidos preservando a primeira ocorrência', () => {
    const out = dedupeStopsById([
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
      { id: 'a', n: 3 },
    ]);
    expect(out).toEqual([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
  });
  it('lista vazia → vazia', () => {
    expect(dedupeStopsById([])).toEqual([]);
  });
  it('sem repetição → idêntica', () => {
    const input = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
    expect(dedupeStopsById(input)).toEqual(input);
  });
});

const mk = (id: string, stopType: RouteStop['stopType']): RouteStop => ({
  id,
  stopType,
  customerUserId: stopType === 'prospect_visit' ? '' : `u-${id}`,
  customerName: id,
  phone: null,
  address: { street: '', number: '', neighborhood: '', city: '', state: '', zip_code: '' },
  timeSlot: null,
  businessHoursOpen: null,
  businessHoursClose: null,
  status: '',
  visitReason: '',
  priorityScore: 0,
  priorityLabel: 'baixa',
  priorityFactors: [],
});

describe('particionarAlvos', () => {
  it('separa prospects (prospect_visit) de clientes (resto)', () => {
    const stops = [mk('a', 'prospect_visit'), mk('b', 'sales_visit'), mk('c', 'prospect_visit')];
    const { clientes, prospects } = particionarAlvos(stops);
    expect(prospects.map((s) => s.id)).toEqual(['a', 'c']);
    expect(clientes.map((s) => s.id)).toEqual(['b']);
  });
});

describe('filtrarAlvos', () => {
  const stops = [mk('a', 'prospect_visit'), mk('b', 'sales_visit')];
  it('todos → tudo', () => {
    expect(filtrarAlvos(stops, 'todos')).toHaveLength(2);
  });
  it('clientes → só não-prospect', () => {
    expect(filtrarAlvos(stops, 'clientes').map((s) => s.id)).toEqual(['b']);
  });
  it('prospects → só prospect_visit', () => {
    expect(filtrarAlvos(stops, 'prospects').map((s) => s.id)).toEqual(['a']);
  });
});

describe('toggleTarget', () => {
  it('adiciona id ausente (novo Set)', () => {
    const a = new Set<string>(['x']);
    const b = toggleTarget(a, 'y');
    expect([...b].sort()).toEqual(['x', 'y']);
    expect(b).not.toBe(a);
  });
  it('remove id presente', () => {
    expect([...toggleTarget(new Set(['x', 'y']), 'x')]).toEqual(['y']);
  });
});
