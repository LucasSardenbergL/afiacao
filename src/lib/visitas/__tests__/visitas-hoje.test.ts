import { describe, it, expect } from 'vitest';
import { montarVisitasHoje } from '../visitas-hoje';

const rows = [
  { id: 'v1', customer_user_id: 'u1' },
  { id: 'v2', customer_user_id: 'u2' },
  { id: 'v3', customer_user_id: 'u3' },
  { id: 'v4', customer_user_id: 'u4' },
];
const nomes = new Map([['u1', 'ACME'], ['u2', 'Beta'], ['u3', 'Gama']]);

describe('montarVisitasHoje', () => {
  it('total = todas as linhas; preview limitado a 3 por padrão', () => {
    const r = montarVisitasHoje(rows, nomes);
    expect(r.total).toBe(4);
    expect(r.preview).toHaveLength(3);
    expect(r.preview.map(p => p.nome)).toEqual(['ACME', 'Beta', 'Gama']);
  });

  it('resolve nome pelo Map e cai pra "Cliente" quando ausente', () => {
    const r = montarVisitasHoje([{ id: 'v4', customer_user_id: 'u4' }], nomes);
    expect(r.preview[0]).toEqual({ id: 'v4', customer_user_id: 'u4', nome: 'Cliente' });
  });

  it('lista vazia → total 0, preview vazio', () => {
    expect(montarVisitasHoje([], nomes)).toEqual({ total: 0, preview: [] });
  });

  it('respeita limit custom', () => {
    expect(montarVisitasHoje(rows, nomes, 2).preview).toHaveLength(2);
  });
});
