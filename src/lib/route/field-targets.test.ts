import { describe, it, expect } from 'vitest';
import { defaultContextForRole, nextModeForContext, dedupeStopsById } from './field-targets';

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
