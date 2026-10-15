import { describe, it, expect } from 'vitest';
import { kpisDesconto, estadoDesconto } from '../desconto-kpis';

const pedido = (...ds: (number | null)[]) => ({ order_items: ds.map((d) => ({ desconto_valor: d })) });

describe('estadoDesconto — três estados que não colapsam', () => {
  it.each([
    [5, 'com'], [0.01, 'com'], [0, 'sem'],
    [null, 'desconhecido'], [undefined, 'desconhecido'], [Number.NaN, 'desconhecido'],
    [Number.POSITIVE_INFINITY, 'desconhecido'], [-1, 'desconhecido'],
  ])('%s → %s', (d, esperado) => {
    expect(estadoDesconto(d as number | null | undefined)).toBe(esperado);
  });
});

describe('kpisDesconto — lê desconto_valor, e NULL (não apurado) ≠ 0', () => {
  it('pedido: com se algum item tem; sem só se TODOS apurados = 0; NULL sem desconto → desconhecido', () => {
    const k = kpisDesconto(
      [pedido(10, 0), pedido(0, 0), pedido(0, null), pedido(null), pedido(null, 3), { order_items: [] }, { order_items: null }],
      [],
    );
    expect(k.pedidosComDesconto).toBe(2);       // (10,0) e (null,3)
    expect(k.pedidosApurados).toBe(3);          // + (0,0)
    expect(k.pedidosDesconhecidos).toBe(4);     // (0,null), (null), [], null
    expect(k.sensibilidade).toBeCloseTo((2 / 3) * 100, 10);
  });

  it('se NULL virasse 0 a sensibilidade cairia — o denominador só tem apurados', () => {
    const k = kpisDesconto([pedido(5), pedido(null), pedido(null), pedido(null)], []);
    expect(k.sensibilidade).toBe(100);          // 1 de 1 apurado — não 1 de 4 (25%)
    expect(k.pedidosDesconhecidos).toBe(3);
  });

  it('zero APURADO agora é fato: 0% é um valor, não indisponível', () => {
    const k = kpisDesconto([pedido(0), pedido(0, 0)], []);
    expect(k.sensibilidade).toBe(0);
    expect(k.pedidosApurados).toBe(2);
  });

  it('amostra toda não apurada (o acervo antigo) → indisponível, não 0% nem −100%', () => {
    const pedidos = Array.from({ length: 500 }, () => pedido(null));
    const itens = Array.from({ length: 1000 }, (_, i) => ({ desconto_valor: null, quantity: (i % 7) + 1 }));
    const k = kpisDesconto(pedidos, itens);
    expect(k.sensibilidade).toBeNull();
    expect(k.elasticidade).toBeNull();
    expect(k).toMatchObject({ pedidosComDesconto: 0, pedidosApurados: 0, pedidosDesconhecidos: 500, itensDesconhecidos: 1000 });
  });

  it('leitura que falhou (undefined) é indisponível, nunca 0', () => {
    expect(kpisDesconto(undefined, undefined)).toEqual({
      sensibilidade: null, pedidosComDesconto: 0, pedidosApurados: 0, pedidosDesconhecidos: 0,
      elasticidade: null, itensDesconhecidos: 0,
    });
  });

  it('elasticidade compara só apurados: o NULL não entra no lado "sem desconto"', () => {
    const itens = [
      { desconto_valor: 2, quantity: 12 },
      { desconto_valor: 0, quantity: 10 },
      { desconto_valor: 0, quantity: 6 },
      { desconto_valor: null, quantity: 1000 }, // se virasse "sem", a média sem iria a ~339
    ];
    const k = kpisDesconto([], itens);
    expect(k.elasticidade).toBe(50);            // 12 contra 8
    expect(k.itensDesconhecidos).toBe(1);
  });

  it('desconto só de um lado (nenhum item apurado sem desconto) não fabrica elasticidade', () => {
    expect(kpisDesconto([], [{ desconto_valor: 3, quantity: 4 }, { desconto_valor: null, quantity: 9 }]).elasticidade).toBeNull();
  });
});
