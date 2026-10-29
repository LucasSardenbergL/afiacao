import { describe, it, expect } from 'vitest';
import type { Tables } from '@/integrations/supabase/types';
import {
  fmtInstanteSP,
  fmtNum,
  MOTIVOS_CORANTE,
  paraGiroCorante,
  regraDaFaixa,
  rotuloMotivo,
} from '@/lib/reposicao/corantes-helpers';

const linha = (p: Partial<Tables<'v_corante_giro'>> = {}): Tables<'v_corante_giro'> => ({
  tint_corante_id: 'c1', wp_codigo: 'WP07', descricao: 'WP07.3900', faixa: 'devagar', faixa_ultimo_calculo: 'devagar',
  motivo: null, consumo_ml_dia: 3.2, consumo_ml_dia_60d: 3, giro_mudando: false, ponto_pedido_ml: 60, maior_dosagem_ml: 30,
  lt_dias_corridos: 9, lt_fonte: 'QT', recarga_ml: 810, k_latas: null, teto_l: 0.81, estoque_fechado_l: 1.62,
  excesso_l: 0.81, cmc_l: 101.08, capital_parado: 81.87, demanda_motor_l_dia: 0.004, dias_cobertos: 180,
  confianca: 'alta', fresco: true, coberto_ate: '2026-10-27T20:00:00Z', capacidade_confirmada: true, ...p,
});

describe('regraDaFaixa — texto da §5.2 da spec', () => {
  it('devagar: 1 lata no máximo, pedida ao abrir a última', () => {
    expect(regraDaFaixa('devagar', null)).toBe('No máximo 1 lata fechada. Pedir 1 QT ao abrir a última.');
  });
  it('rápido: cita k em latas QT e a equivalência do GL', () => {
    expect(regraDaFaixa('rapido', 2)).toContain('2 ou menos latas QT fechadas');
    expect(regraDaFaixa('rapido', 2)).toContain('GL conta pelo equivalente em QT');
    expect(regraDaFaixa('rapido', null)).toBe('—');
  });
  it('sem recomendação: "—", nunca uma regra', () => {
    expect(regraDaFaixa('sem_recomendacao', null)).toBe('—');
  });
  it('muito pouco: cita o lead time quando conhecido', () => {
    expect(regraDaFaixa('muito_pouco', null, 11)).toContain('até 11 dias sem a cor');
    expect(regraDaFaixa('muito_pouco', null)).toContain('até o lead time sem a cor');
  });
  it('parado: não manter lata fechada', () => {
    expect(regraDaFaixa('parado', null)).toMatch(/^Não manter lata fechada/);
  });
});

describe('paraGiroCorante — vocabulário fechado', () => {
  it('lança com faixa fora do vocabulário', () => {
    expect(() => paraGiroCorante(linha({ faixa: 'x' }))).toThrow(/faixa fora do vocabulário: x/);
  });
  it('lança com faixa_ultimo_calculo fora do vocabulário', () => {
    expect(() => paraGiroCorante(linha({ faixa_ultimo_calculo: 'y' }))).toThrow(/faixa_ultimo_calculo fora do vocabulário: y/);
  });
  it.each([
    ['motivo', { motivo: 'novo_motivo' }],
    ['confianca', { confianca: 'certeza_total' }],
    ['lt_fonte', { lt_fonte: 'estimado' }],
  ] as const)('lança com %s fora do vocabulário', (coluna, p) => {
    expect(() => paraGiroCorante(linha(p))).toThrow(new RegExp(`${coluna} fora do vocabulário`));
  });
  it('lança sem as chaves', () => {
    expect(() => paraGiroCorante(linha({ wp_codigo: null }))).toThrow(/sem tint_corante_id\/wp_codigo/);
  });
  it('aceita faixa_ultimo_calculo nula e preserva os nulos de grandeza', () => {
    const g = paraGiroCorante(linha({ faixa: 'sem_recomendacao', faixa_ultimo_calculo: null, excesso_l: null }));
    expect(g.faixa_ultimo_calculo).toBeNull();
    expect(g.excesso_l).toBeNull();
  });
});

describe('rotuloMotivo — os 9 motivos do banco', () => {
  const NOVE = [
    'mais_de_uma_loja', 'sem_cobertura', 'dado_desatualizado', 'cobertura_insuficiente', 'capacidade_nao_confirmada',
    'lt_sem_fonte', 'dosagens_sem_ponte', 'preparacoes_rejeitadas', 'sem_consumo_cobertura_parcial',
  ] as const;
  it('cobre exatamente o vocabulário da migration 20261028100100', () => {
    expect([...MOTIVOS_CORANTE].sort()).toEqual([...NOVE].sort());
  });
  it.each(NOVE)('%s tem rótulo próprio (≠ código)', (m) => {
    expect(rotuloMotivo(m)).not.toBe(m);
    expect(rotuloMotivo(m).length).toBeGreaterThan(5);
  });
});

describe('formatação — ausente ≠ zero', () => {
  it('null vira "—", zero vira 0', () => {
    expect(fmtNum(null, 2)).toBe('—');
    expect(fmtNum(0, 2)).toBe('0,00');
  });
  it('instante em hora de SP', () => {
    expect(fmtInstanteSP('2026-10-27T20:00:00Z')).toBe('27/10/2026, 17:00');
    expect(fmtInstanteSP(null)).toBe('—');
  });
});
