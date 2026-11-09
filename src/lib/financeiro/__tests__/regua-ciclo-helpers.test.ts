import { describe, expect, it } from 'vitest';
import {
  DIAS_MINIMOS_SERIE, DSO_TETO_DIAS, ESTOQUE_ACCOUNT, PME_TETO_DIAS, cmvTtmFechado, dsoPontual, pmeEstoqueMedio, somarDias, type PontoEstoque,
} from '@/lib/financeiro/regua-ciclo-helpers';

// 12 meses fechados anteriores a 2026-10: 2025-10 … 2026-09
const doze = (cmv = 200000) => Array.from({ length: 12 }, (_, i) => {
  const idx = 2025 * 12 + 9 + i; // 2025-10 = 2025*12+9
  return { ano: Math.floor(idx / 12), mes: (idx % 12) + 1, cmv };
});

describe('cmvTtmFechado (espelho da edge estoque-pme.ts)', () => {
  it('soma os 12 meses fechados e ignora o mês corrente e o 13º', () => {
    const r = cmvTtmFechado([...doze(), { ano: 2026, mes: 10, cmv: 999999 }, { ano: 2025, mes: 9, cmv: 999999 }], '2026-10-31');
    expect(r).toEqual({ valor: 2400000, meses: 12, motivo: null });
  });
  it('mês faltando → null com o último mês presente no motivo (nunca soma parcial)', () => {
    const r = cmvTtmFechado(doze().filter((l) => !(l.ano === 2026 && l.mes === 4)), '2026-10-31');
    expect(r.valor).toBeNull();
    expect(r.meses).toBe(11);
    expect(r.motivo).toContain('11/12');
    expect(r.motivo).toContain('2026-09');
  });
  it('mês duplicado, nulo ou não-finito não conta como presente', () => {
    expect(cmvTtmFechado([...doze(), { ano: 2026, mes: 3, cmv: 1 }], '2026-10-31').meses).toBe(11);
    expect(cmvTtmFechado(doze().map((l) => (l.mes === 5 ? { ...l, cmv: null } : l)), '2026-10-31').valor).toBeNull();
    expect(cmvTtmFechado(doze().map((l) => (l.mes === 5 ? { ...l, cmv: Number.POSITIVE_INFINITY } : l)), '2026-10-31').valor).toBeNull();
  });
  it('Σ ≤ 0 → null com motivo (colacor_sc grava 0)', () => {
    expect(cmvTtmFechado(doze(0), '2026-10-31')).toEqual({ valor: null, meses: 12, motivo: 'CMV do DRE zerado nos 12 meses fechados' });
  });
});

describe('dsoPontual — carteira toda ÷ receita/dia', () => {
  it('Oben medido em 2026-10-31: R$ 645.925 abertos ÷ R$ 11.287/dia ≈ 57 d', () => {
    const r = dsoPontual(645925, 4119620 / 365);
    expect(r.motivo).toBeNull();
    expect(r.dias).toBeCloseTo(57.2, 0);
  });
  it('carteira 0 com receita é 0 d (fato); ausências viram null com motivo', () => {
    expect(dsoPontual(0, 100)).toEqual({ dias: 0, motivo: null });
    expect(dsoPontual(null, 100).motivo).toBe('carteira aberta indisponível');
    expect(dsoPontual(100, null).motivo).toBe('sem receita TTM');
    expect(dsoPontual(100, 0).motivo).toBe('sem receita TTM');
    expect(dsoPontual(-5, 100).dias).toBeNull();
  });
  it('receita TTM parcial (< 12 meses) NÃO vira DSO: 6 meses ÷ 365 dobraria o número (Codex)', () => {
    expect(dsoPontual(645925, 2059810 / 365, 6)).toEqual({ dias: null, motivo: 'receita TTM parcial (6 de 12 meses)' });
    expect(dsoPontual(645925, 4119620 / 365, 12).dias).toBeCloseTo(57.2, 0);
  });
  it('acima do teto de plausibilidade não exibe número', () => {
    const r = dsoPontual(100 * (DSO_TETO_DIAS + 1), 100);
    expect(r.dias).toBeNull();
    expect(r.motivo).toContain('teto');
  });
});

describe('pmeEstoqueMedio — série diária dos 90 d', () => {
  const serie = (n: number, desde: string, valor = 480000, coberturaOk = true): PontoEstoque[] =>
    Array.from({ length: n }, (_, i) => ({ dia: somarDias(desde, i), valor, coberturaOk }));

  it('sem ponto: motivo diz que a série nasce no próximo snapshot', () => {
    const r = pmeEstoqueMedio([], 2400000, '2026-10-31');
    expect(r.pme).toBeNull();
    expect(r.diasCobertos).toBe(0);
    expect(r.motivo).toContain('nasce');
  });
  it(`série curta (< ${DIAS_MINIMOS_SERIE} d) → null com N/90 e desde quando`, () => {
    const r = pmeEstoqueMedio(serie(10, '2026-10-22'), 2400000, '2026-10-31');
    expect(r.pme).toBeNull();
    expect(r.diasCobertos).toBe(10);
    expect(r.desde).toBe('2026-10-22');
    expect(r.motivo).toContain('10/90');
  });
  it('60+ dias com cobertura: média ÷ CMV × 365; 1 ponto por dia (o último vence) e fora da janela não conta', () => {
    const pontos = [...serie(70, '2026-08-23', 400000), { dia: '2026-10-31', valor: 500000, coberturaOk: true }, { dia: '2026-05-01', valor: 9e9, coberturaOk: true }];
    const r = pmeEstoqueMedio(pontos, 2400000, '2026-10-31');
    expect(r.diasCobertos).toBe(70);
    // 69 dias a 400k + 1 dia (31/10) a 500k
    const media = (69 * 400000 + 500000) / 70;
    expect(r.estoqueMedio).toBeCloseTo(media, 6);
    expect(r.pme).toBeCloseTo((media / 2400000) * 365, 6);
    expect(r.motivo).toBeNull();
  });
  it('dia com subtotal (custo incompleto) invalida a média; sem CMV não há PME mas a média aparece', () => {
    const pontos = serie(65, '2026-08-28');
    pontos[3] = { ...pontos[3], coberturaOk: false };
    expect(pmeEstoqueMedio(pontos, 2400000, '2026-10-31').motivo).toContain('subtotal');
    const r = pmeEstoqueMedio(serie(65, '2026-08-28'), null, '2026-10-31');
    expect(r.pme).toBeNull();
    expect(r.estoqueMedio).toBe(480000);
    expect(r.motivo).toBe('sem CMV TTM');
  });
  it('a janela tem exatamente 90 datas (hoje inclusive): o 91º dia atrás não entra', () => {
    const pontos = [...serie(90, '2026-08-03', 480000), { dia: '2026-08-02', valor: 96_000_000, coberturaOk: true }];
    const r = pmeEstoqueMedio(pontos, 2400000, '2026-10-31');
    expect(r.diasCobertos).toBe(90);
    expect(r.desde).toBe('2026-08-03');
    expect(r.pme).toBeCloseTo(73, 0);
  });
  it(`PME médio acima do teto (${PME_TETO_DIAS} d) vira null + motivo, nunca 1,46 bilhão de dias`, () => {
    const r = pmeEstoqueMedio(serie(60, '2026-09-02'), 0.12, '2026-10-31');
    expect(r.pme).toBeNull();
    expect(r.motivo).toContain('teto');
  });
  it('conta de estoque espelha _fin_estoque_account', () => {
    expect(ESTOQUE_ACCOUNT).toEqual({ oben: 'vendas', colacor: 'colacor_vendas', colacor_sc: 'servicos' });
    expect(somarDias('2026-03-01', -1)).toBe('2026-02-28');
  });
});
