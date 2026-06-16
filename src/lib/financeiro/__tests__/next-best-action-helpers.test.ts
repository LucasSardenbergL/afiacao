import { describe, it, expect } from 'vitest';
import { caixaDisponivel, hurdleEfetivo, classificarStatus, montarFilaAcoes } from '../next-best-action-helpers';

describe('caixaDisponivel', () => {
  it('saldo − reserva proporcional aos dias de cobertura', () => {
    // cobre 60 dias com 120k; reserva mínima 30 dias → reserva = 120k×30/60 = 60k → disp 60k
    expect(caixaDisponivel({ saldo_tesouraria: 120000, dias_cobertura: 60, reserva_dias_min: 30, confianca_baixa: false })).toBeCloseTo(60000, 0);
  });
  it('cobertura abaixo da reserva mínima → 0 disponível', () => {
    expect(caixaDisponivel({ saldo_tesouraria: 50000, dias_cobertura: 20, reserva_dias_min: 30, confianca_baixa: false })).toBe(0);
  });
  it('confiança baixa → haircut de 50%', () => {
    expect(caixaDisponivel({ saldo_tesouraria: 120000, dias_cobertura: 60, reserva_dias_min: 30, confianca_baixa: true })).toBeCloseTo(30000, 0);
  });
  it('dias_cobertura 0/desconhecido → reserva tudo (0 disponível)', () => {
    expect(caixaDisponivel({ saldo_tesouraria: 100000, dias_cobertura: 0, reserva_dias_min: 30, confianca_baixa: false })).toBe(0);
  });
});

describe('hurdleEfetivo', () => {
  it('WACC presente → usa WACC (fonte wacc)', () => {
    const r = hurdleEfetivo({ wacc: 0.2, custo_divida_pos_imposto: 0.14, retorno_minimo_dono: 0.25, mediana_hurdles: 0.18 });
    expect(r.hurdle).toBe(0.2); expect(r.fonte).toBe('wacc');
  });
  it('sem WACC → retorno do dono (fonte retorno_dono)', () => {
    const r = hurdleEfetivo({ wacc: null, custo_divida_pos_imposto: 0.14, retorno_minimo_dono: 0.25, mediana_hurdles: 0.18 });
    expect(r.hurdle).toBe(0.25); expect(r.fonte).toBe('retorno_dono');
  });
  it('sem WACC nem dono → custo de dívida', () => {
    const r = hurdleEfetivo({ wacc: null, custo_divida_pos_imposto: 0.14, retorno_minimo_dono: null, mediana_hurdles: 0.18 });
    expect(r.hurdle).toBe(0.14); expect(r.fonte).toBe('custo_divida');
  });
  it('só mediana → mediana', () => {
    const r = hurdleEfetivo({ wacc: null, custo_divida_pos_imposto: null, retorno_minimo_dono: null, mediana_hurdles: 0.18 });
    expect(r.hurdle).toBe(0.18); expect(r.fonte).toBe('mediana');
  });
  it('nada → null + indisponivel', () => {
    const r = hurdleEfetivo({ wacc: null, custo_divida_pos_imposto: null, retorno_minimo_dono: null, mediana_hurdles: null });
    expect(r.hurdle).toBeNull(); expect(r.fonte).toBe('indisponivel');
  });
});

describe('classificarStatus', () => {
  it('consertar_valor com EVA+ → consertar_antes (faz primeiro, custo de caixa ~0)', () => {
    expect(classificarStatus({ tipo: 'consertar_valor', impacto_eva: 5000, spread_positivo: null, caixa_consumido: 0, caixa_disponivel: 0, hurdle: 0.2, tem_dado: true })).toBe('consertar_antes');
  });
  it('liberar_caixa → consertar_antes', () => {
    expect(classificarStatus({ tipo: 'liberar_caixa', impacto_eva: 0, spread_positivo: null, caixa_consumido: 0, caixa_disponivel: 0, hurdle: 0.2, tem_dado: true })).toBe('consertar_antes');
  });
  it('crescer spread+ com caixa suficiente → financiar_ja', () => {
    expect(classificarStatus({ tipo: 'crescer', impacto_eva: 8000, spread_positivo: true, caixa_consumido: 40000, caixa_disponivel: 60000, hurdle: 0.2, tem_dado: true })).toBe('financiar_ja');
  });
  it('crescer spread+ SEM caixa → financiar_condicional', () => {
    expect(classificarStatus({ tipo: 'crescer', impacto_eva: 8000, spread_positivo: true, caixa_consumido: 80000, caixa_disponivel: 10000, hurdle: 0.2, tem_dado: true })).toBe('financiar_condicional');
  });
  it('crescer spread NEGATIVO → nao_financiar', () => {
    expect(classificarStatus({ tipo: 'crescer', impacto_eva: -1, spread_positivo: false, caixa_consumido: 10000, caixa_disponivel: 99999, hurdle: 0.2, tem_dado: true })).toBe('nao_financiar');
  });
  it('crescer spread+ MAS sem custo estimado (caixa_consumido null) → falta_dado (precisa dimensionar o ticket)', () => {
    expect(classificarStatus({ tipo: 'crescer', impacto_eva: 8000, spread_positivo: true, caixa_consumido: null, caixa_disponivel: 999999, hurdle: 0.2, tem_dado: true })).toBe('falta_dado');
  });
  it('sem dado (hurdle/sinal ausente) → falta_dado', () => {
    expect(classificarStatus({ tipo: 'crescer', impacto_eva: null, spread_positivo: null, caixa_consumido: null, caixa_disponivel: 0, hurdle: null, tem_dado: false })).toBe('falta_dado');
  });
  it('benchmark → nao_financiar (é o piso quando nada supera o hurdle)', () => {
    expect(classificarStatus({ tipo: 'benchmark', impacto_eva: null, spread_positivo: null, caixa_consumido: 0, caixa_disponivel: 0, hurdle: 0.2, tem_dado: true })).toBe('nao_financiar');
  });
});

const cand = (over: Partial<import('../next-best-action-helpers').AcaoCandidata>): import('../next-best-action-helpers').AcaoCandidata => ({
  empresa: 'oben', descricao: 'x', tipo: 'crescer', impacto_eva: 1000, caixa_consumido: 0, payback_meses: null, spread_positivo: true, confianca: 'alta', ...over,
});

describe('montarFilaAcoes', () => {
  it('ordena por tipo (consertar→liberar→crescer→benchmark) e injeta benchmark', () => {
    const r = montarFilaAcoes({
      candidatos: [
        cand({ tipo: 'crescer', descricao: 'crescer A' }),
        cand({ tipo: 'consertar_valor', descricao: 'cortar desconto', impacto_eva: 500, caixa_consumido: 0 }),
      ],
      caixaPorEmpresa: { oben: { disponivel: 100000, confianca: 'alta' } },
      hurdlePorEmpresa: { oben: 0.2 },
    });
    expect(r.fila[0].tipo).toBe('consertar_valor');
    expect(r.fila.some((a) => a.tipo === 'benchmark')).toBe(true); // benchmark sempre presente
    expect(r.fila[r.fila.length - 1].tipo).toBe('benchmark');
  });

  it('dentro do mesmo tipo, ações sem caixa (preço/prazo) vêm antes; depois por EVA/caixa', () => {
    const r = montarFilaAcoes({
      candidatos: [
        cand({ tipo: 'crescer', descricao: 'cresce caro', impacto_eva: 10000, caixa_consumido: 100000 }),
        cand({ tipo: 'crescer', descricao: 'cresce barato', impacto_eva: 5000, caixa_consumido: 10000 }),
      ],
      caixaPorEmpresa: { oben: { disponivel: 200000, confianca: 'alta' } },
      hurdlePorEmpresa: { oben: 0.2 },
    });
    const crescer = r.fila.filter((a) => a.tipo === 'crescer');
    expect(crescer[0].descricao).toBe('cresce barato'); // EVA/caixa = 0.5 > 0.1
  });

  it('hurdle ausente p/ empresa → status falta_dado nas ações de crescer dela', () => {
    const r = montarFilaAcoes({
      candidatos: [cand({ empresa: 'colacor', tipo: 'crescer', spread_positivo: null })],
      caixaPorEmpresa: { colacor: { disponivel: 50000, confianca: 'media' } },
      hurdlePorEmpresa: {}, // sem hurdle p/ colacor
    });
    const a = r.fila.find((x) => x.empresa === 'colacor')!;
    expect(a.status).toBe('falta_dado');
    expect(a.hurdle).toBeNull();
  });

  it('caixa de uma empresa não financia ação de outra', () => {
    const r = montarFilaAcoes({
      candidatos: [cand({ empresa: 'oben', tipo: 'crescer', caixa_consumido: 40000, spread_positivo: true })],
      caixaPorEmpresa: { oben: { disponivel: 10000, confianca: 'alta' }, colacor: { disponivel: 999999, confianca: 'alta' } },
      hurdlePorEmpresa: { oben: 0.2 },
    });
    // caixa da Oben (10k) < custo (40k) → condicional, ignora o caixa enorme da Colacor
    expect(r.fila.find((a) => a.empresa === 'oben' && a.tipo === 'crescer')!.status).toBe('financiar_condicional');
  });
});

// ── Correções da revisão adversarial (Codex) — invariante "ausente ≠ R$0" no A4 ──
describe('A4 — invariantes (revisão adversarial Codex)', () => {
  // #6 — crescer SEMPRE consome caixa (NCG); custo 0/negativo é dado implausível, não "grátis".
  it('#6 crescer com custo de caixa 0 → falta_dado (não financia como se fosse grátis)', () => {
    expect(classificarStatus({ tipo: 'crescer', impacto_eva: 8000, spread_positivo: true, caixa_consumido: 0, caixa_disponivel: 999999, hurdle: 0.2, tem_dado: true })).toBe('falta_dado');
  });
  it('#6 crescer com custo de caixa negativo → falta_dado', () => {
    expect(classificarStatus({ tipo: 'crescer', impacto_eva: 8000, spread_positivo: true, caixa_consumido: -5000, caixa_disponivel: 999999, hurdle: 0.2, tem_dado: true })).toBe('falta_dado');
  });

  // #7 — hurdle ≤0 é implausível (custo de capital); pula pro próximo fallback (coerência com guards A2/A3).
  it('#7 WACC 0 → pula pro próximo fallback (não aceita hurdle não-positivo)', () => {
    const r = hurdleEfetivo({ wacc: 0, custo_divida_pos_imposto: 0.14, retorno_minimo_dono: 0.25, mediana_hurdles: 0.18 });
    expect(r.hurdle).toBe(0.25); expect(r.fonte).toBe('retorno_dono');
  });
  it('#7 WACC negativo → pula pro próximo fallback', () => {
    const r = hurdleEfetivo({ wacc: -0.05, custo_divida_pos_imposto: null, retorno_minimo_dono: null, mediana_hurdles: 0.18 });
    expect(r.hurdle).toBe(0.18); expect(r.fonte).toBe('mediana');
  });
  it('#7 todos os candidatos a hurdle ≤0 → null/indisponivel (nunca fabrica hurdle não-positivo)', () => {
    const r = hurdleEfetivo({ wacc: 0, custo_divida_pos_imposto: -0.01, retorno_minimo_dono: 0, mediana_hurdles: 0 });
    expect(r.hurdle).toBeNull(); expect(r.fonte).toBe('indisponivel');
  });

  // #7b — a edge NÃO usa hurdleEfetivo (passa o WACC cru). A defesa contra hurdle ≤0 tem de estar na entrada da fila.
  it('#7b hurdle ≤0 vindo do engine é tratado como ausente → crescer cai em falta_dado', () => {
    const r = montarFilaAcoes({
      candidatos: [cand({ empresa: 'oben', tipo: 'crescer', spread_positivo: true, caixa_consumido: 10000 })],
      caixaPorEmpresa: { oben: { disponivel: 100000, confianca: 'alta' } },
      hurdlePorEmpresa: { oben: 0 },
    });
    const a = r.fila.find((x) => x.empresa === 'oben' && x.tipo === 'crescer')!;
    expect(a.hurdle).toBeNull();
    expect(a.status).toBe('falta_dado');
  });

  // #2 — custo DESCONHECIDO (null) não pode ser ordenado como "grátis/retorno infinito" (ausente ≠ 0).
  it('#2 crescer com custo null fica APÓS os dimensionados (não vira grátis/Infinity na fila)', () => {
    const r = montarFilaAcoes({
      candidatos: [
        cand({ tipo: 'crescer', descricao: 'custo desconhecido', impacto_eva: null, caixa_consumido: null, spread_positivo: true }),
        cand({ tipo: 'crescer', descricao: 'dimensionado', impacto_eva: 5000, caixa_consumido: 10000, spread_positivo: true }),
      ],
      caixaPorEmpresa: { oben: { disponivel: 200000, confianca: 'alta' } },
      hurdlePorEmpresa: { oben: 0.2 },
    });
    const crescer = r.fila.filter((a) => a.tipo === 'crescer');
    expect(crescer[0].descricao).toBe('dimensionado');
    expect(crescer[crescer.length - 1].descricao).toBe('custo desconhecido');
  });

  // #3 — EVA ausente (null) não pode virar ratio 0 (ficaria à frente de EVA negativo conhecido).
  it('#3 EVA null não é tratado como 0 no ratio: o de EVA conhecido ordena por ratio, o desconhecido vai ao fim', () => {
    const r = montarFilaAcoes({
      candidatos: [
        cand({ tipo: 'crescer', descricao: 'eva desconhecido', impacto_eva: null, caixa_consumido: 10000, spread_positivo: false }),
        cand({ tipo: 'crescer', descricao: 'eva negativo', impacto_eva: -1000, caixa_consumido: 10000, spread_positivo: false }),
      ],
      caixaPorEmpresa: { oben: { disponivel: 200000, confianca: 'alta' } },
      hurdlePorEmpresa: { oben: 0.2 },
    });
    const crescer = r.fila.filter((a) => a.tipo === 'crescer');
    // atual (buggy): eva null→0 fica ANTES de -1000. Correto: ratio conhecido (mesmo negativo) ordena; o desconhecido vai ao fim.
    expect(crescer[0].descricao).toBe('eva negativo');
    expect(crescer[1].descricao).toBe('eva desconhecido');
  });

  // #9 — o rollup de confiança diz "pior sinal entre caixa/candidatos" mas ignorava candidato.confianca.
  it('#9 candidato de confiança baixa rebaixa o rollup da fila (não fica "alta")', () => {
    const r = montarFilaAcoes({
      candidatos: [cand({ empresa: 'oben', tipo: 'consertar_valor', descricao: 'sleeve incerto', impacto_eva: 1000, caixa_consumido: 0, confianca: 'baixa' })],
      caixaPorEmpresa: { oben: { disponivel: 100000, confianca: 'alta' } },
      hurdlePorEmpresa: { oben: 0.2 },
    });
    expect(r.confianca.nivel).not.toBe('alta');
  });
});
