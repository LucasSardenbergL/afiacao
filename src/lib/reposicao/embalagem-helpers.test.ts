import { describe, it, expect } from 'vitest';
import {
  avaliarOpcao,
  escolherEmbalagemEconomica,
  type OpcaoEmbalagem,
  type ParamsEmbalagem,
} from './embalagem-helpers';

const QT: OpcaoEmbalagem = { sku_codigo_omie: 'QT1', fator_para_base: 1, preco: 10, preco_status: 'ok' };
const GL: OpcaoEmbalagem = { sku_codigo_omie: 'GL1', fator_para_base: 4, preco: 30, preco_status: 'ok' };
const semDemanda: ParamsEmbalagem = { custo_capital_anual: 0.3, limiar_minimo_economia_rs: 5, demanda_base_diaria: null };

describe('avaliarOpcao', () => {
  it('GL com necessidade 1: 1 embalagem, excedente 3, sem capital quando demanda ausente', () => {
    const a = avaliarOpcao(1, GL, semDemanda);
    expect(a).not.toBeNull();
    expect(a!.qtd_embalagens).toBe(1);
    expect(a!.unidades_base_compradas).toBe(4);
    expect(a!.excedente_base).toBe(3);
    expect(a!.custo_direto).toBe(30);
    expect(a!.capital_carrego).toBeNull();
    expect(a!.custo_total_ajustado).toBe(30);
  });

  it('QT casa exato quando necessidade = 4 (sem excedente)', () => {
    const a = avaliarOpcao(4, QT, { ...semDemanda, demanda_base_diaria: 2 });
    expect(a!.qtd_embalagens).toBe(4);
    expect(a!.excedente_base).toBe(0);
    expect(a!.custo_direto).toBe(40);
    expect(a!.capital_carrego).toBe(0);
  });

  it('capital de carrego do excedente é descontado quando há demanda', () => {
    const a = avaliarOpcao(1, { ...GL, preco: 30 }, { custo_capital_anual: 0.5, limiar_minimo_economia_rs: 5, demanda_base_diaria: 0.02 });
    expect(a!.capital_carrego).toBeCloseTo(3 * 7.5 * 0.5 * (150 / 365), 4);
    expect(a!.custo_total_ajustado).toBeCloseTo(30 + 3 * 7.5 * 0.5 * (150 / 365), 4);
  });

  it('retorna null quando preço ausente ou fator inválido', () => {
    expect(avaliarOpcao(1, { ...GL, preco: null }, semDemanda)).toBeNull();
    expect(avaliarOpcao(1, { ...GL, fator_para_base: 0 }, semDemanda)).toBeNull();
  });
});

const params = (over: Partial<ParamsEmbalagem> = {}): ParamsEmbalagem =>
  ({ custo_capital_anual: 0.3, limiar_minimo_economia_rs: 5, demanda_base_diaria: 2, ...over });

describe('escolherEmbalagemEconomica', () => {
  it('QT vence quando GL é caro (necessidade pequena)', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 50, preco_status: 'ok' },
      ],
      params: params(),
    });
    expect(r.status).toBe('ok');
    expect(r.recomendada).toBe('QT');
  });

  it('GL vence quando necessidade é grande e GL/4 < QT', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 4,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 30, preco_status: 'ok' },
      ],
      params: params(),
    });
    expect(r.recomendada).toBe('GL');
  });

  it('GL barato/unidade mas necessidade pequena: o capital come a economia → QT', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 9, preco_status: 'ok' },
      ],
      params: params({ custo_capital_anual: 0.5, demanda_base_diaria: 0.02 }),
    });
    expect(r.recomendada).toBe('QT');
  });

  it('economia abaixo do limiar não empurra overbuy (marginal → recomenda a sem excedente)', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 9.9, preco_status: 'ok' },
      ],
      params: params({ demanda_base_diaria: 1000, limiar_minimo_economia_rs: 1 }),
    });
    expect(r.status).toBe('marginal');
    expect(r.recomendada).toBe('QT');
    expect(r.flags).toContain('overbuy_marginal');
  });

  it('menos de 2 preços informados → indisponivel', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: null, preco_status: null },
      ],
      params: params(),
    });
    expect(r.status).toBe('indisponivel');
    expect(r.recomendada).toBeNull();
  });

  it('preço stale não bloqueia, mas sinaliza', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 4,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'stale' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 30, preco_status: 'ok' },
      ],
      params: params(),
    });
    expect(r.status).not.toBe('indisponivel');
    expect(r.flags).toContain('preco_desatualizado');
  });

  it('demanda ausente: recomenda por custo direto + flag de escoamento', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 4,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 30, preco_status: 'ok' },
      ],
      params: params({ demanda_base_diaria: null }),
    });
    expect(r.recomendada).toBe('GL');
    expect(r.capital_estimado).toBeNull();
    expect(r.flags).toContain('escoamento_nao_estimado');
  });
});
