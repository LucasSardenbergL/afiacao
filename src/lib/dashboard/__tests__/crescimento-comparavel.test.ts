import { describe, it, expect } from 'vitest';
import {
  decomporCrescimento,
  janelasTrimestreFechado,
  type PedidoCliente,
} from '../crescimento-comparavel';

const p = (cliente: string | null, total: number | null): PedidoCliente => ({
  customer_user_id: cliente,
  total,
});

describe('decomporCrescimento', () => {
  it('separa base comparável, entraram e saíram', () => {
    const base = [p('a', 100), p('b', 50), p('c', 30)];
    const atual = [p('a', 120), p('b', 40), p('d', 70)];
    const d = decomporCrescimento(atual, base);

    expect(d.totalAtual).toBe(230);
    expect(d.totalBase).toBe(180);
    expect(d.comparavel).toEqual({ atual: 160, base: 150, clientes: 2 });
    expect(d.entraram).toEqual({ receita: 70, clientes: 1 });
    expect(d.sairam).toEqual({ receita: 30, clientes: 1 });
    expect(d.variacaoTotal).toBeCloseTo(50 / 180);
    expect(d.variacaoComparavel).toBeCloseTo(10 / 150);
    expect(d.participacaoComparavel.atual).toBeCloseTo(160 / 230);
    expect(d.participacaoComparavel.base).toBeCloseTo(150 / 180);
  });

  it('soma vários pedidos do mesmo cliente antes de classificar', () => {
    const d = decomporCrescimento([p('a', 10), p('a', 15)], [p('a', 5), p('a', 5)]);
    expect(d.comparavel).toEqual({ atual: 25, base: 10, clientes: 1 });
    expect(d.entraram.clientes).toBe(0);
    expect(d.sairam.clientes).toBe(0);
  });

  it('pedido sem cliente nunca entra na base comparável: fica em balde próprio', () => {
    const d = decomporCrescimento([p(null, 40), p('a', 10)], [p(null, 25), p('a', 10)]);
    expect(d.comparavel).toEqual({ atual: 10, base: 10, clientes: 1 });
    expect(d.semCliente).toEqual({ atual: 40, base: 25 });
    expect(d.entraram.clientes).toBe(0);
  });

  it('coorte é por PRESENÇA de pedido válido: pedido de R$ 0 ainda faz o cliente comparável', () => {
    const d = decomporCrescimento([p('a', 0)], [p('a', 100)]);
    expect(d.comparavel).toEqual({ atual: 0, base: 100, clientes: 1 });
    expect(d.sairam.clientes).toBe(0);
    expect(d.variacaoComparavel).toBe(-1);
  });

  it('sem interseção nenhuma: base comparável vazia e variação comparável null', () => {
    const d = decomporCrescimento([p('a', 10)], [p('b', 20)]);
    expect(d.comparavel).toEqual({ atual: 0, base: 0, clientes: 0 });
    expect(d.variacaoComparavel).toBeNull();
    expect(d.participacaoComparavel).toEqual({ atual: 0, base: 0 });
  });

  it('só pedidos sem cliente: tudo no balde próprio, nenhum cliente classificado', () => {
    const d = decomporCrescimento([p(null, 10)], [p(null, 30)]);
    expect(d.semCliente).toEqual({ atual: 10, base: 30 });
    expect(d.comparavel.clientes + d.entraram.clientes + d.sairam.clientes).toBe(0);
    expect(d.variacaoTotal).toBeCloseTo(-2 / 3);
  });

  it('ausente ≠ zero: sem base, as variações são null (nunca "+100%" fabricado)', () => {
    const d = decomporCrescimento([p('a', 80)], []);
    expect(d.variacaoTotal).toBeNull();
    expect(d.variacaoComparavel).toBeNull();
    expect(d.entraram).toEqual({ receita: 80, clientes: 1 });
  });

  it('sem receita atual, a participação da base comparável é null (não 0%)', () => {
    const d = decomporCrescimento([], [p('a', 80)]);
    expect(d.participacaoComparavel).toEqual({ atual: null, base: 0 });
    expect(d.variacaoTotal).toBe(-1);
  });

  it('pedidos sem valor são contados, não somados em silêncio', () => {
    const d = decomporCrescimento([p('a', null), p('a', 10)], [p('a', 10), p('b', null)]);
    expect(d.pedidosSemValor).toEqual({ atual: 1, base: 1 });
    expect(d.totalAtual).toBe(10);
  });

  it('identidade da ponte vale para qualquer entrada: Δtotal = Δcomparável + entraram − saíram + ΔsemCliente', () => {
    // Gerador semeado (determinístico): falha reproduzível, sem dependência nova.
    let seed = 20261010;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const gerar = (n: number): PedidoCliente[] =>
      Array.from({ length: n }, () => {
        const r = rnd();
        const cliente = r < 0.1 ? null : `c${Math.floor(rnd() * 25)}`;
        const total = rnd() < 0.05 ? null : rnd() < 0.05 ? 0 : Math.round(rnd() * 100_000) / 100;
        return p(cliente, total);
      });

    for (let caso = 0; caso < 300; caso++) {
      const atual = gerar(Math.floor(rnd() * 60));
      const base = gerar(Math.floor(rnd() * 60));
      const d = decomporCrescimento(atual, base);
      const ponte =
        d.comparavel.atual -
        d.comparavel.base +
        d.entraram.receita -
        d.sairam.receita +
        d.semCliente.atual -
        d.semCliente.base;
      expect(d.totalAtual - d.totalBase, `caso ${caso}`).toBeCloseTo(ponte, 6);
      expect(d.totalAtual, `caso ${caso}`).toBeCloseTo(
        d.comparavel.atual + d.entraram.receita + d.semCliente.atual,
        6,
      );
      expect(d.totalBase, `caso ${caso}`).toBeCloseTo(
        d.comparavel.base + d.sairam.receita + d.semCliente.base,
        6,
      );
    }
  });
});

describe('janelasTrimestreFechado', () => {
  it('últimos 3 meses FECHADOS, o trimestre anterior e o mesmo trimestre do ano anterior', () => {
    expect(janelasTrimestreFechado('2026-10-10')).toEqual({
      atual: { de: '2026-07-01', ate: '2026-10-01' },
      anterior: { de: '2026-04-01', ate: '2026-07-01' },
      anoAnterior: { de: '2025-07-01', ate: '2025-10-01' },
    });
  });

  it('no dia 1 o mês corrente ainda não fechou e fica fora', () => {
    expect(janelasTrimestreFechado('2026-10-01').atual).toEqual({ de: '2026-07-01', ate: '2026-10-01' });
  });

  it('atravessa a virada do ano', () => {
    expect(janelasTrimestreFechado('2026-02-15')).toEqual({
      atual: { de: '2025-11-01', ate: '2026-02-01' },
      anterior: { de: '2025-08-01', ate: '2025-11-01' },
      anoAnterior: { de: '2024-11-01', ate: '2025-02-01' },
    });
  });
});
