import { describe, it, expect } from 'vitest';
import {
  pontoEquilibrio,
  type MesDRE,
  type TipoCusto,
} from '../ponto-equilibrio-helpers';

// ── Fábrica de meses (DRY). Um mês uniforme: receita 100, CMV 60 (variável), aluguel 25 (fixo).
// Reconciliação bate: Σ(despesas)=85 = cmv(60)+op(25). ──────────────────────────────────────
function mesUniforme(ano: number, mes: number, over: Partial<MesDRE> = {}): MesDRE {
  return {
    ano,
    mes,
    receita_bruta: 100,
    deducoes_col: 0,
    despesas: { '2.01.01': 60, '2.04.01': 25 }, // Compras p/ Revenda, Aluguel
    linha_cmv: 60,
    linha_operacionais: 25,
    linha_administrativas: 0,
    linha_comerciais: 0,
    linha_financeiras: 0,
    ...over,
  };
}
const doze = (over?: (mes: number) => Partial<MesDRE>): MesDRE[] =>
  Array.from({ length: 12 }, (_, i) => mesUniforme(2025, i + 1, over?.(i + 1)));

const CLASS: Record<string, TipoCusto> = { '2.01.01': 'variavel', '2.04.01': 'fixo' };

describe('pontoEquilibrio — caminho feliz', () => {
  it('fixos 300 + MC% 40% → PE 750, margem de segurança 37,5%', () => {
    // receita TTM 1200, variáveis 720, fixos 300; MC% = 480/1200 = 0,40; PE = 300/0,40 = 750
    const r = pontoEquilibrio({ meses: doze(), classificacao: CLASS });
    expect(r.motivo).toBe('ok');
    expect(r.pe_receita).toBeCloseTo(750, 2);
    expect(r.mc_pct).toBeCloseTo(0.4, 4);
    expect(r.custos_fixos).toBeCloseTo(300, 2);
    expect(r.custos_variaveis).toBeCloseTo(720, 2);
    expect(r.margem_seguranca_pct).toBeCloseTo(0.375, 4);
    expect(r.cobertura_pct).toBeCloseTo(1, 4);
    expect(r.periodo_label).toBe('jan/2025–dez/2025');
  });
});

describe('pontoEquilibrio — nao_operacional (delta): exclui do PE, reporta, NÃO puxa inconclusivo', () => {
  // receita 100/mês; CMV 60 (variável), aluguel 15 (fixo), "Pagto Empréstimos" 25 (nao_operacional).
  // Linhas: cmv=60, op=40 (15+25 lumpados). Σdespesas=100 = 100 ✓.
  const mesNaoOp = (): Partial<MesDRE> => ({
    despesas: { '2.01.01': 60, '2.04.01': 15, '2.05.03': 25 },
    linha_cmv: 60,
    linha_operacionais: 40,
  });
  const CLASS_NAOOP: Record<string, TipoCusto> = {
    '2.01.01': 'variavel',
    '2.04.01': 'fixo',
    '2.05.03': 'nao_operacional',
  };

  it('o principal de empréstimo NÃO entra em custos_fixos; PE = 180/0,40 = 450', () => {
    const r = pontoEquilibrio({ meses: doze(mesNaoOp), classificacao: CLASS_NAOOP });
    expect(r.motivo).toBe('ok');
    expect(r.custos_fixos).toBeCloseTo(180, 2); // 15*12 — SEM os 300 de empréstimo
    expect(r.pe_receita).toBeCloseTo(450, 2);
  });

  it('reporta o excluído (disclosure E3): TTM 300, recente 25, share 25%', () => {
    const r = pontoEquilibrio({ meses: doze(mesNaoOp), classificacao: CLASS_NAOOP });
    expect(r.excluido_nao_operacional_ttm).toBeCloseTo(300, 2);
    expect(r.excluido_nao_operacional_recente).toBeCloseTo(25, 2);
    expect(r.nao_operacional_share_pct).toBeCloseTo(0.25, 4); // 300/1200 despesas
  });

  it('nao_operacional conta como classificado → cobertura 100%, não inconclusivo', () => {
    const r = pontoEquilibrio({ meses: doze(mesNaoOp), classificacao: CLASS_NAOOP });
    expect(r.cobertura_pct).toBeCloseTo(1, 4);
    expect(r.motivo).not.toBe('inconclusivo');
  });
});

describe('pontoEquilibrio — degradação honesta (motivo, sem número)', () => {
  it('sem meses → sem_dados', () => {
    const r = pontoEquilibrio({ meses: [], classificacao: CLASS });
    expect(r.motivo).toBe('sem_dados');
    expect(r.pe_receita).toBeNull();
  });

  it('receita TTM ≤ 0 → sem_receita', () => {
    const r = pontoEquilibrio({ meses: doze(() => ({ receita_bruta: 0 })), classificacao: CLASS });
    expect(r.motivo).toBe('sem_receita');
    expect(r.pe_receita).toBeNull();
  });

  it('variáveis ≥ receita (MC% ≤ 0) → mc_negativa (perde em cada real; PE não existe)', () => {
    // CMV 120 > receita 100. Σdespesas=120=cmv120. cobertura 100%.
    const mc = (): Partial<MesDRE> => ({ despesas: { '2.01.01': 120 }, linha_cmv: 120, linha_operacionais: 0 });
    const r = pontoEquilibrio({ meses: doze(mc), classificacao: { '2.01.01': 'variavel' } });
    expect(r.motivo).toBe('mc_negativa');
    expect(r.pe_receita).toBeNull();
  });

  it('código material não classificado → inconclusivo (NÃO vira fixo conservador)', () => {
    // 2.05.03=25 (29% das despesas) sem classificação → cobertura 71% < 95%.
    const inc = (): Partial<MesDRE> => ({
      despesas: { '2.01.01': 60, '2.05.03': 25 },
      linha_cmv: 60,
      linha_operacionais: 25,
    });
    const r = pontoEquilibrio({ meses: doze(inc), classificacao: { '2.01.01': 'variavel' } });
    expect(r.motivo).toBe('inconclusivo');
    expect(r.pe_receita).toBeNull();
  });

  it('cobertura OK (96,6%) mas código > 2% da RECEITA não classificado → inconclusivo (isola o gatilho por receita)', () => {
    // 2.05.03=3/mês: 3,4% das despesas (<5%, cobertura 96,6% ≥ 95%) MAS 3% da receita (>2%) → inconclusivo.
    const rec = (): Partial<MesDRE> => ({
      despesas: { '2.01.01': 60, '2.04.01': 25, '2.05.03': 3 },
      linha_cmv: 60,
      linha_operacionais: 28,
    });
    const r = pontoEquilibrio({ meses: doze(rec), classificacao: CLASS });
    expect(r.motivo).toBe('inconclusivo');
    expect(r.cobertura_pct!).toBeGreaterThan(0.95); // prova que NÃO foi a cobertura que disparou
  });

  it("código 'misto' material (>5% despesas) → custo_misto_material", () => {
    const mi = (): Partial<MesDRE> => ({
      despesas: { '2.01.01': 60, '2.01.02': 25 },
      linha_cmv: 60,
      linha_operacionais: 25,
    });
    const r = pontoEquilibrio({
      meses: doze(mi),
      classificacao: { '2.01.01': 'variavel', '2.01.02': 'misto' },
    });
    expect(r.motivo).toBe('custo_misto_material');
    expect(r.pe_receita).toBeNull();
  });

  it('Σdespesas ≠ linhas da DRE → snapshot_inconsistente (reconciliação fail-closed)', () => {
    // Σdespesas=85 mas linhas somam 110 (op=50). |85-110|/110 = 23% > 1%.
    const bad = (): Partial<MesDRE> => ({ linha_operacionais: 50 });
    const r = pontoEquilibrio({ meses: doze(bad), classificacao: CLASS });
    expect(r.motivo).toBe('snapshot_inconsistente');
    expect(r.pe_receita).toBeNull();
  });

  it('MC% mensal volátil (CV alto) → mc_instavel', () => {
    // Meses alternam CMV 40 / CMV 80 → MC% mensal 0,60 / 0,20 (CV 0,50 > 0,35). TTM MC% = 0,40.
    const vol = (mes: number): Partial<MesDRE> => {
      const cmv = mes % 2 === 0 ? 80 : 40;
      return { despesas: { '2.01.01': cmv, '2.04.01': 25 }, linha_cmv: cmv, linha_operacionais: 25 };
    };
    const r = pontoEquilibrio({ meses: doze(vol), classificacao: CLASS });
    expect(r.motivo).toBe('mc_instavel');
    expect(r.pe_receita).toBeNull();
  });

  it('coluna deducoes preenchida (double-count) → deducoes_coluna_inesperada (delta-E5)', () => {
    // deducoes_col 10/mês → 120/1200 = 10% > 1%. O design pressupõe imposto no BALDE, não na coluna.
    const r = pontoEquilibrio({ meses: doze(() => ({ deducoes_col: 10 })), classificacao: CLASS });
    expect(r.motivo).toBe('deducoes_coluna_inesperada');
    expect(r.pe_receita).toBeNull();
  });

  it('despesa negativa material (sinal) → valor_negativo_inesperado (delta-E7)', () => {
    // Devolução -10 no JSON faria custos_variaveis += (-10) INFLAR a margem. Degrada, não adivinha.
    const neg = (): Partial<MesDRE> => ({
      despesas: { '2.01.01': 60, '2.09.01': -10 },
      linha_cmv: 60,
      linha_operacionais: -10,
    });
    const r = pontoEquilibrio({
      meses: doze(neg),
      classificacao: { '2.01.01': 'variavel', '2.09.01': 'variavel' },
    });
    expect(r.motivo).toBe('valor_negativo_inesperado');
    expect(r.pe_receita).toBeNull();
  });
});
