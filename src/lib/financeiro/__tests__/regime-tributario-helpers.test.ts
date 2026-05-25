import { describe, it, expect } from 'vitest';
import { PARTILHA_SIMPLES, partilhaIndiretoFrac, impostoAnualSimples, elegibilidadeSimples } from '../regime-tributario-helpers';

describe('PARTILHA_SIMPLES — invariante de soma', () => {
  it('todas as faixas somam 1.0 (±1e-9)', () => {
    for (const anexo of Object.keys(PARTILHA_SIMPLES) as Array<keyof typeof PARTILHA_SIMPLES>) {
      for (const faixa of PARTILHA_SIMPLES[anexo]) {
        const soma = faixa.irpj + faixa.csll + faixa.cofins + faixa.pis + faixa.cpp + faixa.icms + faixa.iss + faixa.ipi;
        expect(soma).toBeCloseTo(1, 9);
      }
    }
  });
});

describe('partilhaIndiretoFrac — fração indireta (ICMS/ISS/IPI) da alíquota efetiva, com teto de ISS', () => {
  it('anexo I (comércio), 1ª faixa: indireto = ICMS', () => {
    const r = partilhaIndiretoFrac('I', 100000, 0.04);
    expect(r).toBeCloseTo(0.04 * PARTILHA_SIMPLES.I[0].icms, 9);
  });
  it('anexo III, 5ª faixa: ISS satura em 5% e excedente vai pro federal', () => {
    const efetiva = 0.18; // > 0.1492537
    const indireto = partilhaIndiretoFrac('III', 2_000_000, efetiva);
    expect(indireto).toBeCloseTo(0.05, 9);
  });
});

describe('impostoAnualSimples', () => {
  it('decompõe DAS em federal+CPP (tira ICMS/ISS/IPI)', () => {
    const r = impostoAnualSimples({ anexo: 'I', rbt12: 100000, receitaAnual: 100000 });
    expect(r.das_total).toBeCloseTo(4000, 0);
    expect(r.icms_iss_ipi).toBeCloseTo(4000 * PARTILHA_SIMPLES.I[0].icms, 0);
    expect(r.total_federal_cpp).toBeCloseTo(r.das_total - r.icms_iss_ipi, 0);
    expect(r.aproximado).toBe(true);
  });
});

describe('elegibilidadeSimples — usa RBA (ano-calendário), não RBT12', () => {
  it('RBA ≤ 3,6M → elegivel', () => {
    expect(elegibilidadeSimples(3_000_000).status_elegibilidade).toBe('elegivel');
  });
  it('3,6M < RBA ≤ 4,8M → sublimite_excedido (ICMS/ISS fora do DAS)', () => {
    expect(elegibilidadeSimples(4_000_000).status_elegibilidade).toBe('sublimite_excedido');
  });
  it('RBA > 4,8M → inelegivel', () => {
    const r = elegibilidadeSimples(5_000_000);
    expect(r.status_elegibilidade).toBe('inelegivel');
    expect(r.motivo_inelegivel).toContain('4,8');
  });
});
