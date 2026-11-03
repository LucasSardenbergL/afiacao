import { describe, it, expect } from 'vitest';
import { derivarHistorico } from './historico';

const agora = new Date('2026-06-29T12:00:00Z');

describe('derivarHistorico', () => {
  it('agrupa itens por produto, conta vezes e pega o último preço/data', () => {
    const h = derivarHistorico({
      agora,
      pedidos: [],
      itens: [
        { codigo: 1, nome: 'Verniz', quantidade: 2, precoUnit: 40, dataPedido: '2026-05-01' },
        { codigo: 1, nome: 'Verniz', quantidade: 1, precoUnit: 45, dataPedido: '2026-06-10' },
        { codigo: 2, nome: 'Seladora', quantidade: 1, precoUnit: 30, dataPedido: '2026-04-01' },
      ],
    });
    expect(h.topProdutos[0]).toEqual({ codigo: 1, nome: 'Verniz', vezes: 2, ultimoPreco: 45, ultimaData: '2026-06-10' });
    expect(h.topProdutos[1]).toEqual({ codigo: 2, nome: 'Seladora', vezes: 1, ultimoPreco: 30, ultimaData: '2026-04-01' });
  });

  it('ordena por vezes desc, desempata por recência', () => {
    const h = derivarHistorico({
      agora, pedidos: [],
      itens: [
        { codigo: 1, nome: 'A', quantidade: 1, precoUnit: 1, dataPedido: '2026-01-01' },
        { codigo: 2, nome: 'B', quantidade: 1, precoUnit: 1, dataPedido: '2026-06-01' },
        { codigo: 2, nome: 'B', quantidade: 1, precoUnit: 1, dataPedido: '2026-06-02' },
        { codigo: 3, nome: 'C', quantidade: 1, precoUnit: 1, dataPedido: '2026-05-01' },
      ],
    });
    // B (2 vezes) primeiro; depois C e A empatados em 1 → C mais recente que A
    expect(h.topProdutos.map((p) => p.nome)).toEqual(['B', 'C', 'A']);
  });

  it('limita topProdutos a 5', () => {
    const itens = Array.from({ length: 8 }, (_, i) => ({
      codigo: i, nome: `P${i}`, quantidade: 1, precoUnit: 1, dataPedido: '2026-06-01',
    }));
    expect(derivarHistorico({ agora, pedidos: [], itens }).topProdutos).toHaveLength(5);
  });

  it('produtos traz TODOS os SKUs (a ficha procura o SKU sugerido fora do top 5)', () => {
    const itens = Array.from({ length: 8 }, (_, i) => ({
      codigo: i, nome: `P${i}`, quantidade: 1, precoUnit: 10 + i, dataPedido: '2026-06-01',
    }));
    const h = derivarHistorico({ agora, pedidos: [], itens });
    expect(h.produtos).toHaveLength(8);
    expect(h.produtos.find((p) => p.codigo === 7)?.ultimoPreco).toBe(17);
  });

  it('ultimosPedidos = 3 mais recentes por data', () => {
    const h = derivarHistorico({
      agora, itens: [],
      pedidos: [
        { data: '2026-06-10', valor: 100, nItens: 2 },
        { data: '2026-06-20', valor: 200, nItens: 3 },
        { data: '2026-05-01', valor: 50, nItens: 1 },
        { data: '2026-04-01', valor: 30, nItens: 1 },
      ],
    });
    expect(h.ultimosPedidos.map((p) => p.data)).toEqual(['2026-06-20', '2026-06-10', '2026-05-01']);
  });

  it('exclui datas futuras (Omie adianta order_date_kpi)', () => {
    const h = derivarHistorico({
      agora, pedidos: [{ data: '2027-01-01', valor: 999, nItens: 9 }],
      itens: [{ codigo: 1, nome: 'Futuro', quantidade: 1, precoUnit: 1, dataPedido: '2027-01-01' }],
    });
    expect(h.topProdutos).toEqual([]);
    expect(h.ultimosPedidos).toEqual([]);
  });

  it('compra recente SEM preço não esconde o preço antigo — em qualquer ordem', () => {
    const antiga = { codigo: 1, nome: 'Verniz', quantidade: 1, precoUnit: 45, dataPedido: '2026-05-01' };
    const recenteSemPreco = { codigo: 1, nome: 'Verniz', quantidade: 1, precoUnit: null, dataPedido: '2026-06-10' };
    for (const itens of [[antiga, recenteSemPreco], [recenteSemPreco, antiga]]) {
      const [p] = derivarHistorico({ agora, pedidos: [], itens }).produtos;
      expect(p.ultimoPreco).toBe(45);
      expect(p.ultimaData).toBe('2026-06-10');
    }
  });

  it('dois preços na mesma data: vence o MAIOR (bonificação a R$ 0 no dia não vira o último preço)', () => {
    const itens = [
      { codigo: 1, nome: 'Verniz', quantidade: 10, precoUnit: 38, dataPedido: '2026-06-10' },
      { codigo: 1, nome: 'Verniz', quantidade: 1, precoUnit: 0, dataPedido: '2026-06-10' },
      { codigo: 1, nome: 'Verniz', quantidade: 2, precoUnit: 41, dataPedido: '2026-06-10' },
    ];
    expect(derivarHistorico({ agora, pedidos: [], itens }).produtos[0].ultimoPreco).toBe(41);
  });

  it('PERMUTAÇÕES: toda ordem dos mesmos itens dá o mesmo resultado', () => {
    const itens = [
      { codigo: 1, nome: 'Verniz', quantidade: 1, precoUnit: 10, dataPedido: '2026-05-01' },
      { codigo: 1, nome: 'Verniz', quantidade: 1, precoUnit: null, dataPedido: '2026-06-01' },
      { codigo: 1, nome: 'Verniz', quantidade: 1, precoUnit: 20, dataPedido: '2026-05-01' },
      { codigo: 1, nome: 'Verniz', quantidade: 1, precoUnit: 5, dataPedido: '2026-04-01' },
      { codigo: 2, nome: 'Seladora', quantidade: 1, precoUnit: null, dataPedido: '2026-06-05' },
      { codigo: 3, nome: 'Thinner 5L', quantidade: 1, precoUnit: 0, dataPedido: '2026-06-01' }, // nome empata na data → o menor
      { codigo: 3, nome: 'Thinner', quantidade: 1, precoUnit: 30, dataPedido: '2026-06-01' },
      // empata com o código 2 em vezes E data → a ordem da lista desempata pelo código
      { codigo: 0, nome: 'Lixa', quantidade: 1, precoUnit: 7, dataPedido: '2026-06-05' },
    ];
    const esperado = {
      topProdutos: [
        { codigo: 1, nome: 'Verniz', vezes: 4, ultimoPreco: 20, ultimaData: '2026-06-01' },
        { codigo: 3, nome: 'Thinner', vezes: 2, ultimoPreco: 30, ultimaData: '2026-06-01' },
        { codigo: 0, nome: 'Lixa', vezes: 1, ultimoPreco: 7, ultimaData: '2026-06-05' },
        { codigo: 2, nome: 'Seladora', vezes: 1, ultimoPreco: null, ultimaData: '2026-06-05' },
      ],
      ultimosPedidos: [],
    };
    const permutacoes = function* <T>(xs: T[]): Generator<T[]> {
      if (xs.length <= 1) { yield xs; return; }
      for (let i = 0; i < xs.length; i++) {
        for (const resto of permutacoes([...xs.slice(0, i), ...xs.slice(i + 1)])) yield [xs[i], ...resto];
      }
    };
    let n = 0;
    for (const ordem of permutacoes(itens)) {
      const h = derivarHistorico({ agora, pedidos: [], itens: ordem });
      expect(h).toEqual({ ...esperado, produtos: esperado.topProdutos });
      n++;
    }
    expect(n).toBe(40320); // 8! — a suíte percorreu TODAS as ordens
  });

  it('vazio → listas vazias (sem fabricar)', () => {
    expect(derivarHistorico({ agora, itens: [], pedidos: [] })).toEqual({ topProdutos: [], produtos: [], ultimosPedidos: [] });
  });
});
