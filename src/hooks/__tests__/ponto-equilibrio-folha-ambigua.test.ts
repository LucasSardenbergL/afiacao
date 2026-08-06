import { describe, it, expect } from 'vitest';
import { FOLHA_AMBIGUA } from '@/hooks/usePontoEquilibrio';

// FOLHA_AMBIGUA marca, na "referência viva" da folha da CSC (RateioFolhaDialog), os códigos
// 2.03.* que NÃO são custo patronal EXTRA — são RETENÇÃO do empregado, já embutida no Salário
// bruto (2.03.01). Na CSC (Simples) não há INSS patronal, então o INSS/IRRF lançados são a parte
// retida do funcionário; somá-los ao bruto dobraria. O "totalLimpoMes" do dialog exclui esses.
//
// Correção 2026-07-09 (Codex+Claude sobre dados de prod, colacor_sc, TTM competência):
//  • Adiantamento de Salário (2.03.02) NÃO é ambíguo — é a 2ª parcela do MESMO salário: co-ocorre
//    com 2.03.01 até dez/25 e some quando a folha consolidou numa parcela só em jan/26. Custo real.
//  • O par de retenções é INSS (2.03.06) + IRRF (2.03.08) — antes só o IRRF estava marcado.
// Este teste tê-lo-ia pego: o set antigo {2.03.02, 2.03.08} falha as duas primeiras asserções.
describe('FOLHA_AMBIGUA — retenções do empregado (já no salário bruto)', () => {
  it('marca o INSS retido (2.03.06) e o IRRF retido (2.03.08)', () => {
    expect(FOLHA_AMBIGUA.has('2.03.06')).toBe(true); // INSS
    expect(FOLHA_AMBIGUA.has('2.03.08')).toBe(true); // IRRF
  });

  it('NÃO marca o Adiantamento de Salário (2.03.02) — é salário real, não duplicação', () => {
    expect(FOLHA_AMBIGUA.has('2.03.02')).toBe(false);
  });

  it('NÃO marca custo patronal real: Salários bruto (2.03.01) nem FGTS (2.03.07)', () => {
    expect(FOLHA_AMBIGUA.has('2.03.01')).toBe(false);
    expect(FOLHA_AMBIGUA.has('2.03.07')).toBe(false);
  });
});
