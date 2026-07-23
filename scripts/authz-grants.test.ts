import { describe, it, expect } from 'vitest';
import { AUTHZ_TABELAS_FECHADAS, type TabelaFechada } from './authz-tabelas-fechadas';

describe('AUTHZ_TABELAS_FECHADAS — sanidade do contrato', () => {
  it('tem as duas tabelas money-path fechadas por privilégio', () => {
    expect(Object.keys(AUTHZ_TABELAS_FECHADAS).sort()).toEqual([
      'public.omie_products',
      'public.product_costs',
    ]);
  });

  it('toda entrada tem permitido para anon e authenticated e um motivo não-vazio', () => {
    for (const [chave, e] of Object.entries(AUTHZ_TABELAS_FECHADAS) as [string, TabelaFechada][]) {
      expect(Array.isArray(e.permitido.anon), chave).toBe(true);
      expect(Array.isArray(e.permitido.authenticated), chave).toBe(true);
      expect(e.motivo.length, chave).toBeGreaterThan(10);
    }
  });

  it('chave está em minúsculo e no formato schema.name', () => {
    for (const chave of Object.keys(AUTHZ_TABELAS_FECHADAS)) {
      expect(chave).toBe(chave.toLowerCase());
      expect(chave.split('.')).toHaveLength(2);
    }
  });
});
