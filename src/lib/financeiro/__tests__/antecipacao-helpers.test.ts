import { describe, it, expect } from 'vitest';
import { diasEntre, custoOperacao } from '../antecipacao-helpers';

const op = (over: Partial<Parameters<typeof custoOperacao>[0]> = {}) => ({
  valor_bruto: 100_000,
  custos_avulsos: 0,
  valor_liquido: 97_000,
  data_operacao: '2026-01-01',
  data_vencimento: '2026-01-31',
  ...over,
});

describe('diasEntre', () => {
  it('conta dias corridos entre datas ISO (sem drift de TZ)', () => {
    expect(diasEntre('2026-01-01', '2026-01-31')).toBe(30);
    expect(diasEntre('2026-03-01', '2026-03-01')).toBe(0);
  });
});

describe('custoOperacao — caminho feliz', () => {
  it('custo = bruto+avulsos−liquido; taxa período e a.a. de caso conhecido', () => {
    const r = custoOperacao(op());
    expect(r.motivo).toBe('ok');
    expect(r.custo).toBeCloseTo(3_000, 2);
    expect(r.dias).toBe(30);
    expect(r.taxa_periodo).toBeCloseTo(100_000 / 97_000 - 1, 6); // ~0,030928
    expect(r.taxa_efetiva_aa).toBeCloseTo(Math.pow(100_000 / 97_000, 365 / 30) - 1, 6); // ~0,4486
  });

  it('custos_avulsos (IOF/tarifa FORA do líquido) entram no custo (P1-4)', () => {
    const r = custoOperacao(op({ custos_avulsos: 500 }));
    expect(r.custo).toBeCloseTo(3_500, 2); // 100000+500−97000
    expect(r.taxa_periodo).toBeCloseTo(100_500 / 97_000 - 1, 6);
  });

  it('líquido == bruto+avulsos → custo 0 / taxa 0, VÁLIDO (P1-1: igualdade não é inválida)', () => {
    const r = custoOperacao(op({ valor_liquido: 100_000, custos_avulsos: 0 }));
    expect(r.motivo).toBe('ok');
    expect(r.custo).toBeCloseTo(0, 6);
    expect(r.taxa_periodo).toBeCloseTo(0, 6);
    expect(r.taxa_efetiva_aa).toBeCloseTo(0, 6);
  });
});

describe('custoOperacao — dados_invalidos (helper blinda além do CHECK)', () => {
  it('líquido > bruto+avulsos → dados_invalidos (P1-1: inválido só quando MAIOR)', () => {
    const r = custoOperacao(op({ valor_liquido: 100_001 }));
    expect(r.motivo).toBe('dados_invalidos');
    expect(r.custo).toBeNull();
  });
  it('dias ≤ 0 (venc ≤ operação) → dados_invalidos', () => {
    const r = custoOperacao(op({ data_vencimento: '2026-01-01' }));
    expect(r.motivo).toBe('dados_invalidos');
  });
  it('valores ≤ 0 ou custos_avulsos < 0 → dados_invalidos', () => {
    expect(custoOperacao(op({ valor_bruto: 0 })).motivo).toBe('dados_invalidos');
    expect(custoOperacao(op({ valor_liquido: 0 })).motivo).toBe('dados_invalidos');
    expect(custoOperacao(op({ custos_avulsos: -1 })).motivo).toBe('dados_invalidos');
  });
});
