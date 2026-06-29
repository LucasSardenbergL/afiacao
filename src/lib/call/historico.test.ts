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

  it('vazio → listas vazias (sem fabricar)', () => {
    expect(derivarHistorico({ agora, itens: [], pedidos: [] })).toEqual({ topProdutos: [], ultimosPedidos: [] });
  });
});
