import { describe, it, expect } from 'vitest';
import { exportDRECSV } from '@/services/financeiroService';
import { makeDRE } from '@/components/financeiro/dashboard/__tests__/factories';

describe('exportDRECSV', () => {
  it('exporta outras_receitas, outras_despesas e resultado_antes_impostos na ordem da DRE', () => {
    const csv = exportDRECSV([
      makeDRE({ mes: 3, ano: 2026, resultado_operacional: 100, outras_receitas: 70, outras_despesas: 20, resultado_antes_impostos: 150, impostos: 10, resultado_liquido: 140 }),
    ]);
    const linhas = csv.split('\n').map((l) => l.split(/[;,]/));
    const pos = (campo: string) => linhas.findIndex((l) => l[0].replace(/"/g, '') === campo);
    expect(pos('outras_receitas')).toBeGreaterThan(pos('resultado_operacional'));
    expect(pos('outras_despesas')).toBe(pos('outras_receitas') + 1);
    expect(pos('resultado_antes_impostos')).toBe(pos('outras_despesas') + 1);
    expect(pos('impostos')).toBe(pos('resultado_antes_impostos') + 1);
    expect(linhas[pos('outras_receitas')][1]).toContain('70');
    expect(linhas[pos('outras_despesas')][1]).toContain('20');
    expect(linhas[pos('resultado_antes_impostos')][1]).toContain('150');
  });
});
