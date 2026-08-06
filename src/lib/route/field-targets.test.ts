import { describe, it, expect } from 'vitest';
import {
  defaultContextForRole,
  nextModeForContext,
  dedupeStopsById,
  particionarAlvos,
  filtrarAlvos,
  toggleTarget,
  FILTROS_ALVO_INICIAL,
  aplicarFiltrosAlvos,
  bairrosDe,
} from './field-targets';
import type { RouteStop } from '@/components/rota/planner/types';

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

const mk = (
  id: string,
  stopType: RouteStop['stopType'],
  over: Partial<RouteStop> = {},
): RouteStop => ({
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
  ...over,
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

describe('aplicarFiltrosAlvos', () => {
  const stops = [
    mk('ana', 'sales_visit', { customerName: 'Ana Marcenaria', phone: '3399', address: { street: '', number: '', neighborhood: 'Centro', city: '', state: '', zip_code: '' } }),
    mk('beto', 'prospect_visit', { customerName: 'Beto Móveis', phone: null, prospeccaoStatus: 'a_contatar', address: { street: '', number: '', neighborhood: 'Niterói', city: '', state: '', zip_code: '' } }),
    mk('caio', 'prospect_visit', { customerName: 'Caio MDF', phone: '3311', prospeccaoStatus: 'em_conversa', address: { street: '', number: '', neighborhood: 'Centro', city: '', state: '', zip_code: '' } }),
  ];

  it('inicial (todos, sem critérios) → tudo', () => {
    expect(aplicarFiltrosAlvos(stops, FILTROS_ALVO_INICIAL)).toHaveLength(3);
  });
  it('busca por nome ignora acento e caixa', () => {
    const out = aplicarFiltrosAlvos(stops, { ...FILTROS_ALVO_INICIAL, busca: 'moveis' });
    expect(out.map((s) => s.id)).toEqual(['beto']);
  });
  it('comTelefone exclui quem não tem phone', () => {
    const out = aplicarFiltrosAlvos(stops, { ...FILTROS_ALVO_INICIAL, comTelefone: true });
    expect(out.map((s) => s.id)).toEqual(['ana', 'caio']);
  });
  it('status (multi) filtra prospects pelo prospeccaoStatus e exclui clientes', () => {
    const out = aplicarFiltrosAlvos(stops, { ...FILTROS_ALVO_INICIAL, status: ['em_conversa'] });
    expect(out.map((s) => s.id)).toEqual(['caio']);
  });
  it('bairro exato', () => {
    const out = aplicarFiltrosAlvos(stops, { ...FILTROS_ALVO_INICIAL, bairro: 'Centro' });
    expect(out.map((s) => s.id)).toEqual(['ana', 'caio']);
  });
  it('combina tipo + telefone', () => {
    const out = aplicarFiltrosAlvos(stops, { ...FILTROS_ALVO_INICIAL, tipo: 'prospects', comTelefone: true });
    expect(out.map((s) => s.id)).toEqual(['caio']);
  });
});

describe('bairrosDe', () => {
  it('únicos, ordenados pt-BR, ignora vazio/whitespace', () => {
    const stops = [
      mk('a', 'sales_visit', { address: { street: '', number: '', neighborhood: 'Niterói', city: '', state: '', zip_code: '' } }),
      mk('b', 'prospect_visit', { address: { street: '', number: '', neighborhood: 'Centro', city: '', state: '', zip_code: '' } }),
      mk('c', 'sales_visit', { address: { street: '', number: '', neighborhood: '  ', city: '', state: '', zip_code: '' } }),
      mk('d', 'sales_visit', { address: { street: '', number: '', neighborhood: 'Centro', city: '', state: '', zip_code: '' } }),
    ];
    expect(bairrosDe(stops)).toEqual(['Centro', 'Niterói']);
  });
  it('lista vazia → vazia', () => {
    expect(bairrosDe([])).toEqual([]);
  });
});
