import { describe, it, expect } from 'vitest';
import {
  fontesDaLinha, aliasesDaLinha, drillLinha, codigosDaLinha,
  type DimRowRaw,
} from '../orcamento-drill-helpers';

const row = (codigo: string, mes: number, valor: number, desc = codigo): DimRowRaw => ({
  categoria_codigo: codigo, categoria_descricao: desc, mes, valor,
});
const map = (codigo: string, dre_linha: string, company = '_default') => ({ omie_codigo: codigo, dre_linha, company });

describe('fontesDaLinha', () => {
  it('receitas → cr; despesas → cp; deducoes → cr+cp; derivada → []', () => {
    expect(fontesDaLinha('receita_bruta')).toEqual(['cr']);
    expect(fontesDaLinha('receitas_financeiras')).toEqual(['cr']);
    expect(fontesDaLinha('despesas_comerciais')).toEqual(['cp']);
    expect(fontesDaLinha('impostos')).toEqual(['cp']);
    expect(fontesDaLinha('deducoes')).toEqual(['cr', 'cp']);
    expect(fontesDaLinha('resultado_operacional')).toEqual([]);
    expect(fontesDaLinha('lucro_bruto')).toEqual([]);
  });
});

describe('aliasesDaLinha', () => {
  it('deducoes agrega sublinhas fiscais + das + impostos legado (ambos regimes)', () => {
    const esperado = ['deducoes','ded_icms','ded_iss','ded_pis','ded_cofins','ded_ipi','das','impostos'];
    expect(aliasesDaLinha('deducoes', 'simples').sort()).toEqual([...esperado].sort());
    expect(aliasesDaLinha('deducoes', 'presumido').sort()).toEqual([...esperado].sort());
  });
  it('impostos: simples vazio (DAS está em deducoes), presumido irpj+csll', () => {
    expect(aliasesDaLinha('impostos', 'simples')).toEqual([]);
    expect(aliasesDaLinha('impostos', 'presumido').sort()).toEqual(['csll','irpj']);
  });
  it('linha comum → alias literal', () => {
    expect(aliasesDaLinha('cmv', 'presumido')).toEqual(['cmv']);
    expect(aliasesDaLinha('despesas_comerciais', 'simples')).toEqual(['despesas_comerciais']);
  });
});

describe('drillLinha', () => {
  const base = {
    mesesFechados: [1, 2, 3],
    forecastRestante: 1000,
    varianciaAnual: -500,
    realizadoSnapshot: 300,
  };

  it('decompõe por código, ordena por |realizado_ytd| desc, calcula delta/peso e reconcilia ok', () => {
    const rowsAno = [
      row('2.01.01', 1, 100), row('2.01.01', 2, 100),
      row('2.01.02', 1, 100),
      row('2.01.99', 4, 999),
    ];
    const rowsAnoAnterior = [row('2.01.01', 1, 50), row('2.01.02', 1, 80)];
    const r = drillLinha({
      dreLinha: 'despesas_comerciais', regime: 'presumido',
      rowsAno, rowsAnoAnterior, mapping: [map('2.01.01','despesas_comerciais'), map('2.01.02','despesas_comerciais'), map('2.01.99','cmv')],
      ...base,
    });
    expect(r.fontes).toEqual(['cp']);
    expect(r.componentes.map(c => c.categoria_codigo)).toEqual(['2.01.01', '2.01.02']);
    expect(r.componentes[0].realizado_ytd).toBe(200);
    expect(r.componentes[0].realizado_ytd_ano_anterior).toBe(50);
    expect(r.componentes[0].delta).toBe(150);
    expect(r.componentes[0].delta_perc).toBeCloseTo(3, 5);
    expect(r.componentes[0].peso_perc).toBeCloseTo(200 / 300, 5);
    expect(r.total_decomposto).toBe(300);
    expect(r.residuo).toBe(0);
    expect(r.qualidade).toBe('ok');
    expect(r.forecast_nao_decomposto).toBe(1000);
    expect(r.variancia_anual).toBe(-500);
  });

  it('mapping: company sobrescreve _default — INDEPENDENTE DA ORDEM do array (P1)', () => {
    const rowsAno = [row('2.01.01', 1, 100)];
    const ordemA = [map('2.01.01','despesas_comerciais','_default'), map('2.01.01','cmv','oben')];
    const ordemB = [map('2.01.01','cmv','oben'), map('2.01.01','despesas_comerciais','_default')];
    for (const mapping of [ordemA, ordemB]) {
      const r = drillLinha({ dreLinha: 'despesas_comerciais', regime: 'presumido', rowsAno, rowsAnoAnterior: [], mapping, ...base, realizadoSnapshot: 0 });
      expect(r.componentes).toHaveLength(0);
      expect(r.total_decomposto).toBe(0);
    }
    const rInv = drillLinha({ dreLinha: 'cmv', regime: 'presumido', rowsAno, rowsAnoAnterior: [], mapping: ordemA, ...base, realizadoSnapshot: 100 });
    expect(rInv.componentes).toHaveLength(1);
    expect(rInv.componentes[0].realizado_ytd).toBe(100);
  });

  it('multi-source: mesmo código em CR e CP soma (deducoes; consistente c/ snapshot, P1)', () => {
    const rowsAno = [row('1.05.01', 1, 100, 'ICMS'), row('1.05.01', 2, 50, 'ICMS')];
    const r = drillLinha({
      dreLinha: 'deducoes', regime: 'presumido',
      rowsAno, rowsAnoAnterior: [], mapping: [map('1.05.01','ded_icms')],
      ...base, realizadoSnapshot: 150,
    });
    expect(r.componentes).toHaveLength(1);
    expect(r.componentes[0].realizado_ytd).toBe(150);
    expect(r.qualidade).toBe('ok');
  });

  it('presumido: código mapeado p/ literal "impostos" cai em DEDUCOES, não impostos (normalização legado, P2)', () => {
    const rowsAno = [row('9.99', 1, 300, 'Imposto legado')];
    const mapping = [map('9.99','impostos')];
    const rDed = drillLinha({ dreLinha: 'deducoes', regime: 'presumido', rowsAno, rowsAnoAnterior: [], mapping, ...base, realizadoSnapshot: 300 });
    expect(rDed.componentes).toHaveLength(1);
    const rImp = drillLinha({ dreLinha: 'impostos', regime: 'presumido', rowsAno, rowsAnoAnterior: [], mapping, ...base, realizadoSnapshot: 0 });
    expect(rImp.componentes).toHaveLength(0);
  });

  it('mês: mes null não entra e não gera NaN; mesesFechados vazio → tudo fora', () => {
    const rowsAno = [row('4.01', 1, 100), { categoria_codigo: '4.01', categoria_descricao: '4.01', mes: null, valor: 999 }];
    const r1 = drillLinha({ dreLinha: 'cmv', regime: 'presumido', rowsAno, rowsAnoAnterior: [], mapping: [map('4.01','cmv')], ...base, mesesFechados: [1], realizadoSnapshot: 100 });
    expect(r1.componentes[0].realizado_ytd).toBe(100);
    expect(Number.isFinite(r1.total_decomposto)).toBe(true);
    const r2 = drillLinha({ dreLinha: 'cmv', regime: 'presumido', rowsAno, rowsAnoAnterior: [], mapping: [map('4.01','cmv')], ...base, mesesFechados: [], realizadoSnapshot: 0 });
    expect(r2.componentes).toHaveLength(0);
    expect(r2.total_decomposto).toBe(0);
  });

  it('valores negativos (estorno): ordenação por |realizado|, peso e reconciliação sem NaN', () => {
    const rowsAno = [row('5.01', 1, -200, 'Estorno'), row('5.02', 1, 100, 'Normal')];
    const r = drillLinha({
      dreLinha: 'outras_despesas', regime: 'presumido',
      rowsAno, rowsAnoAnterior: [], mapping: [map('5.01','outras_despesas'), map('5.02','outras_despesas')],
      ...base, realizadoSnapshot: -100,
    });
    expect(r.componentes[0].categoria_codigo).toBe('5.01');
    expect(r.total_decomposto).toBe(-100);
    expect(r.componentes.every(c => Number.isFinite(c.peso_perc))).toBe(true);
    expect(r.qualidade).toBe('ok');
  });

  it('peso_perc com total decomposto zero (compensação) → 0, sem Infinity/NaN', () => {
    const rowsAno = [row('6.01', 1, 100), row('6.02', 1, -100)];
    const r = drillLinha({
      dreLinha: 'outras_despesas', regime: 'presumido',
      rowsAno, rowsAnoAnterior: [], mapping: [map('6.01','outras_despesas'), map('6.02','outras_despesas')],
      ...base, realizadoSnapshot: 0,
    });
    expect(r.total_decomposto).toBe(0);
    expect(r.componentes.every(c => c.peso_perc === 0)).toBe(true);
    expect(r.residuo_perc).toBeNull();
    expect(r.qualidade).toBe('ok');
  });

  it('label fallback p/ código só no ano-1; delta_perc denominador absoluto', () => {
    const r = drillLinha({
      dreLinha: 'despesas_administrativas', regime: 'presumido',
      rowsAno: [], rowsAnoAnterior: [row('3.01', 1, 200, 'Aluguel 2025')],
      mapping: [map('3.01','despesas_administrativas')],
      ...base, realizadoSnapshot: 0,
    });
    expect(r.componentes[0].categoria_descricao).toBe('Aluguel 2025');
    expect(r.componentes[0].realizado_ytd).toBe(0);
    expect(r.componentes[0].realizado_ytd_ano_anterior).toBe(200);
    expect(r.componentes[0].delta).toBe(-200);
    expect(r.componentes[0].delta_perc).toBeCloseTo(-1, 5);
  });

  it('reconciliação ok = (≤5% E ≤R$10k); parcial (5-20%); diagnostico (>20%)', () => {
    const mk = (snapshot: number) => drillLinha({
      dreLinha: 'cmv', regime: 'presumido',
      rowsAno: [row('4.01', 1, 100)], rowsAnoAnterior: [], mapping: [map('4.01','cmv')],
      mesesFechados: [1], forecastRestante: 0, varianciaAnual: 0, realizadoSnapshot: snapshot,
    });
    expect(mk(110).qualidade).toBe('parcial');
    expect(mk(200).qualidade).toBe('diagnostico');
    expect(mk(101).qualidade).toBe('ok');
  });

  it('reconciliação: resíduo % pequeno mas absoluto grande (>R$10k) → parcial, não ok (AND)', () => {
    const rowsAno = [row('4.01', 1, 5_000_000)];
    const r = drillLinha({ dreLinha: 'cmv', regime: 'presumido', rowsAno, rowsAnoAnterior: [], mapping: [map('4.01','cmv')], mesesFechados: [1], forecastRestante: 0, varianciaAnual: 0, realizadoSnapshot: 5_040_000 });
    expect(r.qualidade).toBe('parcial');
  });

  it('snapshot≈0 mas decomposto≠0 → diagnostico', () => {
    const r = drillLinha({
      dreLinha: 'cmv', regime: 'presumido',
      rowsAno: [row('4.01', 1, 100)], rowsAnoAnterior: [], mapping: [map('4.01','cmv')],
      mesesFechados: [1], forecastRestante: 0, varianciaAnual: 0, realizadoSnapshot: 0,
    });
    expect(r.residuo_perc).toBeNull();
    expect(r.qualidade).toBe('diagnostico');
  });
});

describe('codigosDaLinha', () => {
  const map = (c: string, l: string, company = '_default') => ({ omie_codigo: c, dre_linha: l, company });
  it('resolve company>_default order-independent; filtra por alias; dedup', () => {
    const ordemA = [map('1','despesas_comerciais','_default'), map('1','cmv','oben'), map('2','despesas_comerciais')];
    const ordemB = [...ordemA].reverse();
    expect(codigosDaLinha(ordemA,'cmv','presumido').sort()).toEqual(['1']);
    expect(codigosDaLinha(ordemB,'cmv','presumido').sort()).toEqual(['1']);
    expect(codigosDaLinha(ordemA,'despesas_comerciais','presumido').sort()).toEqual(['2']);
  });
  it('aliases fiscais regime-aware: deducoes pega ded_*/das; impostos simples vazio', () => {
    const m = [map('a','ded_icms'), map('b','das'), map('c','irpj')];
    expect(codigosDaLinha(m,'deducoes','presumido').sort()).toEqual(['a','b']);
    expect(codigosDaLinha(m,'impostos','simples')).toEqual([]);
    expect(codigosDaLinha(m,'impostos','presumido')).toEqual(['c']);
  });
});
