import { describe, it, expect } from 'vitest';
import { calcularDsoDpo, janelaTTM, type DsoDpoInput } from '../dso-dpo-helpers';

const base: DsoDpoInput = {
  arAberto: 100_000,
  apAberto: 60_000,
  receitaBrutaTTM: 1_200_000,
  cmvTTM: 730_000,
  mesesFechados: 12,
  diasPeriodo: 365,
  periodoLabel: 'jun/2025–mai/2026',
};

describe('calcularDsoDpo', () => {
  it('calcula DSO = AR aberto ÷ receita_bruta diária TTM (arredondado em dias)', () => {
    // 100.000 / (1.200.000/365) = 100.000 / 3287,67 = 30,42 → 30
    const r = calcularDsoDpo(base);
    expect(r.dso).toBe(30);
  });

  it('calcula DPO = AP aberto ÷ CMV diário TTM', () => {
    // 60.000 / (730.000/365) = 60.000 / 2000 = 30
    const r = calcularDsoDpo(base);
    expect(r.dpo).toBe(30);
  });

  it('AR aberto = 0 com receita > 0 → DSO 0 (NÃO null) [codex]', () => {
    const r = calcularDsoDpo({ ...base, arAberto: 0 });
    expect(r.dso).toBe(0);
  });

  it('AP aberto = 0 com CMV > 0 → DPO 0', () => {
    const r = calcularDsoDpo({ ...base, apAberto: 0 });
    expect(r.dpo).toBe(0);
  });

  it('receita TTM ausente/≤0 → DSO null', () => {
    expect(calcularDsoDpo({ ...base, receitaBrutaTTM: 0 }).dso).toBeNull();
    expect(calcularDsoDpo({ ...base, receitaBrutaTTM: null }).dso).toBeNull();
    expect(calcularDsoDpo({ ...base, receitaBrutaTTM: -5 }).dso).toBeNull();
  });

  it('CMV TTM ausente/≤0 → DPO null', () => {
    expect(calcularDsoDpo({ ...base, cmvTTM: 0 }).dpo).toBeNull();
    expect(calcularDsoDpo({ ...base, cmvTTM: null }).dpo).toBeNull();
  });

  it('AR/AP aberto null → respectivo indicador null (denominador ok)', () => {
    expect(calcularDsoDpo({ ...base, arAberto: null }).dso).toBeNull();
    expect(calcularDsoDpo({ ...base, apAberto: null }).dpo).toBeNull();
  });

  it('TTM incompleto (<12 meses fechados) → DSO e DPO null + caveat', () => {
    const r = calcularDsoDpo({ ...base, mesesFechados: 9 });
    expect(r.dso).toBeNull();
    expect(r.dpo).toBeNull();
    expect(r.caveats.some((c) => c.includes('TTM incompleto'))).toBe(true);
  });

  it('diasPeriodo ≤ 0 → null (sem divisão por zero)', () => {
    const r = calcularDsoDpo({ ...base, diasPeriodo: 0 });
    expect(r.dso).toBeNull();
    expect(r.dpo).toBeNull();
  });

  it('caveats obrigatórios sempre presentes (snapshot + DPO sobre CMV)', () => {
    const r = calcularDsoDpo(base);
    expect(r.caveats.some((c) => c.toLowerCase().includes('point-in-time'))).toBe(true);
    expect(r.caveats.some((c) => c.toLowerCase().includes('cmv'))).toBe(true);
  });

  it('disponivel=true se ao menos um indicador computou; false se nenhum', () => {
    expect(calcularDsoDpo(base).disponivel).toBe(true);
    expect(calcularDsoDpo({ ...base, mesesFechados: 0 }).disponivel).toBe(false);
    // só DSO computa (CMV ausente) → ainda disponivel
    expect(calcularDsoDpo({ ...base, cmvTTM: null }).disponivel).toBe(true);
  });

  it('saldo negativo (não deveria ocorrer) é tratado como 0, não infla', () => {
    expect(calcularDsoDpo({ ...base, arAberto: -1000 }).dso).toBe(0);
  });

  it('guard de plausibilidade: DSO > 730 dias → null + caveat (não mostra falsa precisão)', () => {
    // AR 1M / receita 100k/ano = 3650 dias → descartado
    const r = calcularDsoDpo({ ...base, arAberto: 1_000_000, receitaBrutaTTM: 100_000 });
    expect(r.dso).toBeNull();
    expect(r.caveats.some((c) => c.includes('incoerente_plausibilidade'))).toBe(true);
  });

  it('guard de plausibilidade: DPO > 730 (caso colacor real AP 792k / CMV 199k ≈ 1450d) → null', () => {
    const r = calcularDsoDpo({ ...base, apAberto: 792_550, cmvTTM: 199_482 });
    expect(r.dpo).toBeNull();
    expect(r.caveats.some((c) => c.includes('incoerente_plausibilidade'))).toBe(true);
  });

  it('valor plausível (≤730) NÃO é descartado', () => {
    // AR 600k / (1.2M/365) = 182,5 → Math.round = 183 dias → mantém (≤730)
    const r = calcularDsoDpo({ ...base, arAberto: 600_000 });
    expect(r.dso).toBe(183);
    expect(r.caveats.some((c) => c.includes('incoerente_plausibilidade'))).toBe(false);
  });

  it('eco dos insumos no resultado (transparência)', () => {
    const r = calcularDsoDpo(base);
    expect(r.ar_aberto).toBe(100_000);
    expect(r.receita_bruta_ttm).toBe(1_200_000);
    expect(r.meses_fechados).toBe(12);
    expect(r.periodo_label).toBe('jun/2025–mai/2026');
  });
});

describe('janelaTTM', () => {
  it('exclui o mês corrente; pega os 12 fechados (meio do ano)', () => {
    const j = janelaTTM(new Date(2026, 4, 30)); // maio/2026 (corrente, não entra)
    expect(j.pares).toHaveLength(12);
    expect(j.pares[0]).toEqual({ ano: 2025, mes: 5 });
    expect(j.pares[11]).toEqual({ ano: 2026, mes: 4 });
    expect(j.periodoLabel).toBe('05/2025–04/2026');
    expect(j.diasPeriodo).toBe(365);
  });

  it('vira o ano corretamente (janeiro → ano anterior inteiro)', () => {
    const j = janelaTTM(new Date(2026, 0, 10)); // jan/2026 corrente
    expect(j.pares[0]).toEqual({ ano: 2025, mes: 1 });
    expect(j.pares[11]).toEqual({ ano: 2025, mes: 12 });
    expect(j.periodoLabel).toBe('01/2025–12/2025');
    expect(j.diasPeriodo).toBe(365);
  });

  it('conta o dia extra de fevereiro bissexto (2024)', () => {
    const j = janelaTTM(new Date(2024, 2, 1)); // mar/2024 corrente → TTM mar/23–fev/24
    expect(j.pares[0]).toEqual({ ano: 2023, mes: 3 });
    expect(j.pares[11]).toEqual({ ano: 2024, mes: 2 });
    expect(j.diasPeriodo).toBe(366);
  });
});
