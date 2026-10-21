import { describe, expect, it } from 'vitest';
import {
  calcularRecompra,
  situacaoComprador,
  valorAtrasado,
  type LinhaPedido,
  type RecompraSku,
} from '../recompra';

const C = 'comprador-c';

function linha(data: string, over: Partial<LinhaPedido> = {}): LinhaPedido {
  return {
    comprador_id: C,
    empresa: 'oben',
    omie_codigo_produto: 111,
    quantidade: 10,
    preco_unit_liquido: 5,
    data_pedido: data,
    ...over,
  };
}

// SKU 111: pedidos em 2026-01-01, 01-31, 03-02 → intervalos 30, 30 → cadência 30.
const TRES = [linha('2026-01-01'), linha('2026-01-31'), linha('2026-03-02')];

function sku(over: Partial<RecompraSku> = {}): RecompraSku {
  return {
    comprador_id: C,
    empresa: 'oben',
    omie_codigo_produto: 111,
    n_pedidos: 3,
    cadencia_dias: 30,
    qtd_sugerida: 10,
    ultima_compra: '2026-03-02',
    ultimo_preco: 5,
    due_ratio: 1,
    atrasado: false,
    valor_esperado: 50,
    ...over,
  };
}

describe('calcularRecompra', () => {
  it('cadência = mediana dos intervalos entre dias distintos; atrasado com due_ratio ≥ 1,5', () => {
    const [s] = calcularRecompra(TRES, '2026-04-20');
    expect(s.cadencia_dias).toBe(30);
    expect(s.n_pedidos).toBe(3);
    expect(s.ultima_compra).toBe('2026-03-02');
    expect(s.due_ratio).toBeCloseTo(49 / 30, 10);
    expect(s.atrasado).toBe(true);
    expect(s.qtd_sugerida).toBe(10);
    expect(s.valor_esperado).toBe(50);
  });

  it('due_ratio exatamente 1,5 é atrasado; abaixo não', () => {
    // última 2026-03-02 + 45 dias = 2026-04-16
    expect(calcularRecompra(TRES, '2026-04-16')[0].atrasado).toBe(true);
    expect(calcularRecompra(TRES, '2026-04-15')[0].atrasado).toBe(false);
  });

  it('menos de 3 dias de pedido → SKU fora', () => {
    expect(calcularRecompra(TRES.slice(0, 2), '2026-04-20')).toEqual([]);
  });

  it('várias linhas no MESMO dia contam 1 dia; quantidade do dia é a soma', () => {
    const linhas = [...TRES, linha('2026-03-02', { quantidade: 30, preco_unit_liquido: 7 })];
    const [s] = calcularRecompra(linhas, '2026-04-20');
    expect(s.n_pedidos).toBe(3);
    // qtd por dia: 10, 10, 40 → mediana 10
    expect(s.qtd_sugerida).toBe(10);
    // preço do último dia ponderado pela quantidade: (10×5 + 30×7) / 40 = 6,5
    expect(s.ultimo_preco).toBeCloseTo(6.5, 10);
  });

  it('pedido em data ≥ hoje é ignorado (sem olhar o futuro)', () => {
    const base = calcularRecompra(TRES, '2026-04-20');
    const comFuturo = calcularRecompra(
      [...TRES, linha('2026-04-20'), linha('2026-05-01')],
      '2026-04-20',
    );
    expect(comFuturo).toEqual(base);
  });

  it('pedido mais velho que 540 dias é ignorado', () => {
    // hoje − 540 = 2024-10-27 (limite inclusivo)
    const velho = linha('2024-10-26');
    const noLimite = linha('2024-10-27');
    expect(calcularRecompra([velho, ...TRES.slice(0, 2)], '2026-04-20')).toEqual([]);
    expect(calcularRecompra([noLimite, ...TRES.slice(0, 2)], '2026-04-20')).toHaveLength(1);
  });

  it('preço ausente → ultimo_preco e valor_esperado null, nunca 0', () => {
    const linhas = TRES.map((l, i) => (i === 2 ? { ...l, preco_unit_liquido: null } : l));
    const [s] = calcularRecompra(linhas, '2026-04-20');
    expect(s.ultimo_preco).toBeNull();
    expect(s.valor_esperado).toBeNull();
  });

  it('Oben e Colacor do mesmo comprador ficam em linhas separadas', () => {
    const colacor = TRES.map((l) => ({ ...l, empresa: 'colacor' as const }));
    const r = calcularRecompra([...TRES, ...colacor], '2026-04-20');
    expect(r.map((s) => s.empresa)).toEqual(['colacor', 'oben']);
  });

  it('cadência par → média dos dois do meio', () => {
    // 5 dias → intervalos 10, 20, 30, 40 → mediana (20 + 30) / 2 = 25
    const linhas = ['2026-01-01', '2026-01-11', '2026-01-31', '2026-03-02', '2026-04-11'].map((d) => linha(d));
    expect(calcularRecompra(linhas, '2026-04-20')[0].cadencia_dias).toBe(25);
  });

  it('quantidade não positiva é descartada', () => {
    const linhas = [...TRES.slice(0, 2), linha('2026-03-02', { quantidade: 0 })];
    expect(calcularRecompra(linhas, '2026-04-20')).toEqual([]);
  });
});

describe('situacaoComprador', () => {
  it('perdido: 400 dias sem compra com cadência 30 → perdido', () => {
    expect(situacaoComprador([sku()], '2025-03-16', '2026-04-20', 10)).toBe('perdido');
  });

  it('cadência 200 → perdido só após 600 dias', () => {
    const s = [sku({ cadencia_dias: 200 })];
    // 2026-04-20 − 600 dias = 2024-08-28
    expect(situacaoComprador(s, '2024-08-28', '2026-04-20', 10)).toBe('em_dia');
    expect(situacaoComprador(s, '2024-08-27', '2026-04-20', 10)).toBe('perdido');
  });

  it('sem SKU qualificado e < 3 dias de pedido → sem_base (ausente ≠ em dia)', () => {
    expect(situacaoComprador([], '2026-04-01', '2026-04-20', 2)).toBe('sem_base');
    expect(situacaoComprador([], null, '2026-04-20', 0)).toBe('sem_base');
  });

  it('sem SKU qualificado mas com ≥ 3 dias e compra recente → em_dia', () => {
    expect(situacaoComprador([], '2026-04-01', '2026-04-20', 5)).toBe('em_dia');
  });

  it('sem SKU qualificado, ≥ 3 dias e > 365 dias sem compra → perdido', () => {
    expect(situacaoComprador([], '2025-04-19', '2026-04-20', 5)).toBe('perdido');
  });

  it('algum SKU atrasado → atrasado; nenhum → em_dia', () => {
    expect(situacaoComprador([sku(), sku({ omie_codigo_produto: 2, atrasado: true })], '2026-04-01', '2026-04-20', 9)).toBe('atrasado');
    expect(situacaoComprador([sku()], '2026-04-01', '2026-04-20', 9)).toBe('em_dia');
  });
});

describe('valorAtrasado', () => {
  it('soma o valor esperado só dos SKUs atrasados', () => {
    expect(valorAtrasado([sku({ atrasado: true }), sku({ atrasado: true, valor_esperado: 20 }), sku()])).toBe(70);
  });
  it('nenhum atrasado → 0 (zero de verdade)', () => {
    expect(valorAtrasado([sku()])).toBe(0);
  });
  it('atrasados sem preço → null (ausente ≠ zero); com preço parcial soma os conhecidos', () => {
    expect(valorAtrasado([sku({ atrasado: true, valor_esperado: null })])).toBeNull();
    expect(valorAtrasado([sku({ atrasado: true, valor_esperado: null }), sku({ atrasado: true })])).toBe(50);
  });
});
