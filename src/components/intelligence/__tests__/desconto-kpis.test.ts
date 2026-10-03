import { describe, it, expect } from 'vitest';
import { kpisDesconto } from '../desconto-kpis';

// A produção de hoje: `discount` é 0 em 100% das linhas de pedido e de item (DEFAULT 0, sem escritor).
const pedidosDeProducao = Array.from({ length: 500 }, () => ({ discount: 0 }));
const itensDeProducao = Array.from({ length: 1000 }, (_, i) => ({ discount: 0, quantity: (i % 7) + 1 }));

describe('kpisDesconto — coluna sem dado não vira 0% nem −100%', () => {
  it('produção de hoje (tudo 0): os DOIS KPIs ficam indisponíveis (null), não 0% e −100%', () => {
    const k = kpisDesconto(pedidosDeProducao, itensDeProducao);
    expect(k.sensibilidade).toBeNull();
    expect(k.elasticidade).toBeNull();
    // o contador segue sendo fato: 0 de 500 — só o PERCENTUAL é que não se afirma
    expect(k).toMatchObject({ pedidosComDesconto: 0, pedidos: 500 });
  });

  it('leitura que falhou (undefined) é indisponível, nunca 0', () => {
    expect(kpisDesconto(undefined, undefined)).toEqual({
      sensibilidade: null,
      pedidosComDesconto: 0,
      pedidos: 0,
      elasticidade: null,
    });
  });

  it('com desconto registrado, os números voltam (o dia em que a coluna ganhar escritor)', () => {
    const pedidos = [{ discount: 10 }, { discount: 0 }, { discount: 0 }, { discount: 5 }];
    const itens = [
      { discount: 2, quantity: 12 },
      { discount: 0, quantity: 10 },
      { discount: 0, quantity: 6 },
    ];
    const k = kpisDesconto(pedidos, itens);
    expect(k.sensibilidade).toBe(50);
    expect(k.pedidosComDesconto).toBe(2);
    // média com desconto 12 contra 8 sem: +50%
    expect(k.elasticidade).toBe(50);
  });

  it('desconto só de um lado (nenhum item sem desconto) não fabrica elasticidade', () => {
    expect(kpisDesconto([], [{ discount: 3, quantity: 4 }]).elasticidade).toBeNull();
  });
});
