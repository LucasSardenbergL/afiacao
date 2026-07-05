import { describe, it, expect } from 'vitest';
import {
  termometroAntecipacao,
  CONFIG_ANTECIPACAO_PADRAO,
  type LinhaAntecipacao,
} from '../antecipacao-helpers';

const linha = (over: Partial<LinhaAntecipacao> = {}): LinhaAntecipacao => ({
  id: 'l1',
  credor: 'Banco X',
  saldo_devedor: 100000,
  cet_aa: 0.3,
  coobrigada_por: null,
  ...over,
});

describe('termometroAntecipacao', () => {
  it('sem linhas → empty-state educativo (não é erro, nunca finge número)', () => {
    const r = termometroAntecipacao({ linhas: [], ar_aberto: 400000, receita_liquida_ttm: 2_000_000 });
    expect(r.motivo).toBe('sem_linhas');
    expect(r.nivel).toBeNull();
    expect(r.exposicao_sacada).toBe(0);
    expect(r.custo_recorrente_aa).toBeNull(); // NÃO 0
    expect(r.custo_sobre_receita_pct).toBeNull();
    expect(r.exposicao_sobre_ar_pct).toBeNull();
    expect(r.credores).toEqual([]);
  });

  it('caminho feliz: nível pelo dreno de margem (custo/receita 3% → média)', () => {
    const r = termometroAntecipacao({
      linhas: [linha({ saldo_devedor: 200000, cet_aa: 0.3 })], // custo = 60.000
      ar_aberto: 400000,
      receita_liquida_ttm: 2_000_000, // 60k/2M = 3% ∈ [2%,5%) → média
    });
    expect(r.motivo).toBe('ok');
    expect(r.custo_recorrente_aa).toBe(60000);
    expect(r.custo_sobre_receita_pct).toBeCloseTo(0.03, 6);
    expect(r.exposicao_sobre_ar_pct).toBeCloseTo(0.5, 6);
    expect(r.nivel).toBe('media');
    expect(r.falta_cet).toBe(false);
    expect(r.falta_receita).toBe(false);
    expect(r.falta_ar).toBe(false);
  });

  it('nível alta: custo/receita ≥ 5%', () => {
    const r = termometroAntecipacao({
      linhas: [linha({ saldo_devedor: 300000, cet_aa: 0.4 })], // custo = 120.000
      ar_aberto: 400000,
      receita_liquida_ttm: 2_000_000, // 6% ≥ 5%
    });
    expect(r.nivel).toBe('alta');
  });

  it('nível baixa: custo/receita < 2%', () => {
    const r = termometroAntecipacao({
      linhas: [linha({ saldo_devedor: 50000, cet_aa: 0.2 })], // custo = 10.000
      ar_aberto: 400000,
      receita_liquida_ttm: 2_000_000, // 0.5% < 2%
    });
    expect(r.nivel).toBe('baixa');
  });

  it('linha MATERIAL sem cet → custo null (nunca 0); nível cai no fallback de dependência', () => {
    const r = termometroAntecipacao({
      linhas: [
        linha({ id: 'a', saldo_devedor: 200000, cet_aa: null }), // material (66%), sem cet
        linha({ id: 'b', saldo_devedor: 100000, cet_aa: 0.3 }),
      ],
      ar_aberto: 400000, // dependência 300k/400k = 0.75 ≥ 0.60 → alta
      receita_liquida_ttm: 2_000_000,
    });
    expect(r.falta_cet).toBe(true);
    expect(r.custo_recorrente_aa).toBeNull();
    expect(r.custo_sobre_receita_pct).toBeNull();
    expect(r.exposicao_sobre_ar_pct).toBeCloseTo(0.75, 6);
    expect(r.nivel).toBe('alta'); // via dependência
    expect(r.motivo).toBe('ok');
  });

  it('linha imaterial sem cet → custo ainda computado (omite a desprezível), falta_cet false', () => {
    const r = termometroAntecipacao({
      linhas: [
        linha({ id: 'a', saldo_devedor: 200000, cet_aa: 0.3 }), // material
        linha({ id: 'b', saldo_devedor: 5000, cet_aa: null }), // 5k/205k = 2.4% < 5% → imaterial
      ],
      ar_aberto: 400000,
      receita_liquida_ttm: 2_000_000,
    });
    expect(r.falta_cet).toBe(false);
    expect(r.custo_recorrente_aa).toBe(60000); // só a linha 'a'
    expect(r.exposicao_sacada).toBe(205000);
  });

  it('falta receita → dreno null; nível pela dependência', () => {
    const r = termometroAntecipacao({
      linhas: [linha({ saldo_devedor: 200000, cet_aa: 0.3 })],
      ar_aberto: 400000, // 0.5 ∈ [0.3,0.6) → média
      receita_liquida_ttm: null,
    });
    expect(r.falta_receita).toBe(true);
    expect(r.custo_recorrente_aa).toBe(60000); // custo existe
    expect(r.custo_sobre_receita_pct).toBeNull(); // mas o ratio não
    expect(r.nivel).toBe('media'); // via dependência
  });

  it('falta AR → dependência null; nível pelo dreno de margem', () => {
    const r = termometroAntecipacao({
      linhas: [linha({ saldo_devedor: 200000, cet_aa: 0.3 })],
      ar_aberto: null,
      receita_liquida_ttm: 2_000_000, // 3% → média
    });
    expect(r.falta_ar).toBe(true);
    expect(r.exposicao_sobre_ar_pct).toBeNull();
    expect(r.nivel).toBe('media'); // via custo
  });

  it('linhas presentes mas nenhum saldo conhecido → sem_base', () => {
    const r = termometroAntecipacao({
      linhas: [linha({ saldo_devedor: null }), linha({ id: 'b', saldo_devedor: null })],
      ar_aberto: 400000,
      receita_liquida_ttm: 2_000_000,
    });
    expect(r.motivo).toBe('sem_base');
    expect(r.n_linhas).toBe(2);
    expect(r.exposicao_sacada).toBe(0);
    expect(r.nivel).toBeNull();
    expect(r.custo_recorrente_aa).toBeNull();
  });

  it('saldo presente mas sem cet (material) E sem receita E sem AR → sem_base', () => {
    const r = termometroAntecipacao({
      linhas: [linha({ saldo_devedor: 200000, cet_aa: null })],
      ar_aberto: null,
      receita_liquida_ttm: null,
    });
    expect(r.motivo).toBe('sem_base');
    expect(r.nivel).toBeNull();
    expect(r.falta_cet).toBe(true);
    expect(r.exposicao_sacada).toBe(200000); // o saldo é conhecido, só não dá pra dar nível
  });

  it('dependência é CRUA e pode exceder 100% (base divergente / over-hocking)', () => {
    const r = termometroAntecipacao({
      linhas: [linha({ saldo_devedor: 500000, cet_aa: 0.3 })],
      ar_aberto: 400000, // 500k/400k = 1.25
      receita_liquida_ttm: null, // força o nível pela dependência
    });
    expect(r.exposicao_sobre_ar_pct).toBeCloseTo(1.25, 6);
    expect(r.nivel).toBe('alta'); // 1.25 ≥ 0.60
  });

  it('concentração por credor: share do maior + lista ordenada desc', () => {
    const r = termometroAntecipacao({
      linhas: [
        linha({ id: 'a', credor: 'Banco X', saldo_devedor: 300000, cet_aa: 0.3 }),
        linha({ id: 'b', credor: 'Banco Y', saldo_devedor: 100000, cet_aa: 0.3 }),
      ],
      ar_aberto: 800000,
      receita_liquida_ttm: 2_000_000,
    });
    expect(r.exposicao_sacada).toBe(400000);
    expect(r.concentracao_credor_pct).toBeCloseTo(0.75, 6);
    expect(r.credores.map((c) => c.credor)).toEqual(['Banco X', 'Banco Y']);
    expect(r.credores[0].share_pct).toBeCloseTo(0.75, 6);
  });

  it('mesmo credor em 2 linhas → agregado num só (concentração 100%)', () => {
    const r = termometroAntecipacao({
      linhas: [
        linha({ id: 'a', credor: 'Banco X', saldo_devedor: 200000, cet_aa: 0.3 }),
        linha({ id: 'b', credor: 'Banco X', saldo_devedor: 100000, cet_aa: 0.3 }),
      ],
      ar_aberto: 600000,
      receita_liquida_ttm: 2_000_000,
    });
    expect(r.credores).toHaveLength(1);
    expect(r.concentracao_credor_pct).toBeCloseTo(1, 6);
  });

  it('coobrigação: só soma as linhas co-obrigadas COM saldo', () => {
    const r = termometroAntecipacao({
      linhas: [
        linha({ id: 'a', saldo_devedor: 200000, cet_aa: 0.3, coobrigada_por: 'colacor' }),
        linha({ id: 'b', saldo_devedor: 100000, cet_aa: 0.3, coobrigada_por: null }),
        linha({ id: 'c', saldo_devedor: null, cet_aa: 0.3, coobrigada_por: 'colacor' }), // sem saldo → fora
      ],
      ar_aberto: 800000,
      receita_liquida_ttm: 2_000_000,
    });
    expect(r.coobrigacao_total).toBe(200000);
  });

  it('linha com saldo null não entra no exposicao_sacada mas conta em n_linhas', () => {
    const r = termometroAntecipacao({
      linhas: [
        linha({ id: 'a', saldo_devedor: 200000, cet_aa: 0.3 }),
        linha({ id: 'b', saldo_devedor: null, cet_aa: 0.3 }),
      ],
      ar_aberto: 400000,
      receita_liquida_ttm: 2_000_000,
    });
    expect(r.n_linhas).toBe(2);
    expect(r.exposicao_sacada).toBe(200000);
  });

  it('config padrão exposta com os limiares esperados', () => {
    expect(CONFIG_ANTECIPACAO_PADRAO.nivelAltaReceita).toBe(0.05);
    expect(CONFIG_ANTECIPACAO_PADRAO.nivelMediaReceita).toBe(0.02);
  });
});
