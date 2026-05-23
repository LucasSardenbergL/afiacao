// src/lib/access/access-matrix.test.ts
import { describe, it, expect } from 'vitest';
import { canAccess, isReadOnly } from './access-matrix';

describe('canAccess', () => {
  it('vendedor: vendas/clientes/performance sim; financeiro/operacao/reposicao não', () => {
    expect(canAccess('vendedor', 'vendas')).toBe(true);
    expect(canAccess('vendedor', 'clientes')).toBe(true);
    expect(canAccess('vendedor', 'performance')).toBe(true);
    expect(canAccess('vendedor', 'financeiro')).toBe(false);
    expect(canAccess('vendedor', 'operacao')).toBe(false);
    expect(canAccess('vendedor', 'reposicao')).toBe(false);
  });
  it('gestor_comercial: inteligencia sim; financeiro/operacao não', () => {
    expect(canAccess('gestor_comercial', 'inteligencia')).toBe(true);
    expect(canAccess('gestor_comercial', 'clientes')).toBe(true);
    expect(canAccess('gestor_comercial', 'financeiro')).toBe(false);
    expect(canAccess('gestor_comercial', 'operacao')).toBe(false);
  });
  it('operacao: operacao sim; vendas/clientes não', () => {
    expect(canAccess('operacao', 'operacao')).toBe(true);
    expect(canAccess('operacao', 'vendas')).toBe(false);
    expect(canAccess('operacao', 'clientes')).toBe(false);
  });
  it('financeiro: financeiro/clientes sim; vendas leitura', () => {
    expect(canAccess('financeiro', 'financeiro')).toBe(true);
    expect(canAccess('financeiro', 'clientes')).toBe(true);
    expect(canAccess('financeiro', 'vendas')).toBe(true);
    expect(isReadOnly('financeiro', 'vendas')).toBe(true);
  });
  it('gestao: acessa tudo', () => {
    for (const s of ['principal','clientes','vendas','operacao','reposicao','performance','inteligencia','financeiro','tintometrico_cockpit','gestao_admin','docs'] as const) {
      expect(canAccess('gestao', s)).toBe(true);
    }
  });
  it('docs liberado pra todas as personas staff', () => {
    for (const p of ['vendedor','gestor_comercial','operacao','financeiro','gestao'] as const) {
      expect(canAccess(p, 'docs')).toBe(true);
    }
  });
});
